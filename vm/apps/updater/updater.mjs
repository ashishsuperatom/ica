// ── The Superatom Engine Updater: switches a project's engine to the release the platform chose (docs/deploying-the-engine.md) ──
//
// One small process beside the engine, in its own container, with the Docker socket and the engine's volume. It asks
// nothing of the platform: the engine writes the platform's choice into <project home>/engine-release/desired.json, and
// this reads it. Plain Node and Docker's own API — nothing to install.
//
// A SWITCH, in order — each step's failure says which step, and leaves the previous engine running:
//   1. pull the chosen image, while the engine still works            (fails: refused; nothing changed)
//   2. stop the engine, giving it a minute to finish what it is doing  (one engine at a time, never two)
//   3. copy its database folder aside
//   4. start the new engine in its place, with the same volume, settings and restart rule
//   5. wait for it to reach the platform (it writes running.json)     (90 s)
//   6. kept: the old container removed, the newest three images kept, the rest removed
//      not up in time, or it crashed: its last log lines kept, it is removed, the database copy restored, the previous
//      engine started again — and that release is not tried again until a different one is chosen
// Every step is reported to the platform AS IT HAPPENS (the engine is down mid-switch, so this speaks for the box, with the
// project's engine key): the admin console shows the switch step by step, and the people using the project see that it is
// updating. Every outcome is also written to result.json, which the engine reports when it connects.
// If this process dies mid-switch, its next start finds the previous engine set aside and puts it back.
import http from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PREVIOUS = (name) => `${name}-previous`

/** Docker's API over its socket. */
export function dockerClient(socketPath = '/var/run/docker.sock') {
  const call = (method, path, body, { stream = false, timeoutMs = 120_000 } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: `/v1.43${path}`, headers: body ? { 'content-type': 'application/json' } : {}, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 400) return reject(new Error(`docker ${method} ${path.split('?')[0]} → ${res.statusCode}: ${text.slice(0, 300)}`))
        if (stream) return resolve(text)
        try { resolve(text ? JSON.parse(text) : null) } catch { resolve(text) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path.split('?')[0]}: no answer in ${timeoutMs / 1000}s`)))
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
  return {
    inspect: (name) => call('GET', `/containers/${encodeURIComponent(name)}/json`).catch((e) => (/→ 404/.test(e.message) ? null : Promise.reject(e))),
    pull: async (image) => {
      const at = image.lastIndexOf('@'), repo = image.slice(0, at), digest = image.slice(at + 1)
      const out = await call('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(digest)}`, null, { stream: true, timeoutMs: 30 * 60_000 })
      const err = out.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((x) => x?.error)
      if (err) throw new Error(err.error)
    },
    stop: (id, seconds) => call('POST', `/containers/${id}/stop?t=${seconds}`, null, { timeoutMs: (seconds + 30) * 1000 }).catch((e) => (/→ 304/.test(e.message) ? null : Promise.reject(e))),
    start: (id) => call('POST', `/containers/${id}/start`).catch((e) => (/→ 304/.test(e.message) ? null : Promise.reject(e))),
    rename: (id, name) => call('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`),
    remove: (id) => call('DELETE', `/containers/${id}?force=true`),
    create: (name, spec) => call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec),
    logs: async (id) => (await call('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=40`, null, { stream: true })).replace(/[\x00-\x08\x0e-\x1f]/g, ''),
    images: () => call('GET', '/images/json'),
    removeImage: (id) => call('DELETE', `/images/${id}`),
  }
}

/** One look: switch if the platform chose a release the engine does not run. Returns what happened, for logs and tests. */
export async function tick({ docker, engine, fsys = defaultFs, log = console.log, healthSeconds = 90, stopSeconds = 60, keepImages = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), report }) {
  // A switch cut short (this process died mid-way): the previous engine is set aside and the engine is gone — put it back.
  const cur = await docker.inspect(engine)
  const prev = await docker.inspect(PREVIOUS(engine))
  if (!cur && prev) {
    await docker.rename(prev.Id, engine); await docker.start(prev.Id)
    log(`[engine-updater] a switch was cut short — the previous engine is back`)
    return 'recovered'
  }
  if (!cur) return 'no-engine'
  // An engine someone stopped stays stopped: a release chosen meanwhile waits for it to run again.
  if (!cur.State?.Running) return 'engine-stopped'
  const dir = releaseDir(cur)
  const desired = fsys.read(join(dir, 'desired.json'))
  if (!desired?.image) return 'nothing-chosen'
  if (cur.Config.Image === desired.image) return 'up-to-date'
  const last = fsys.read(join(dir, 'result.json'))
  // A release that went back is not tried again — until someone chooses it again (a choice newer than that outcome).
  if (last && last.to === desired.digest && ['rolled-back', 'refused'].includes(last.state) && !(desired.chosenAt && Date.parse(desired.chosenAt) > Date.parse(last.at))) return 'not-retried'
  return switchTo({ docker, engine, cur, prevLeftover: prev, desired, dir, fsys, log, healthSeconds, stopSeconds, keepImages, sleep, now, report: report ?? platformReporter(cur, log) })
}

async function switchTo({ docker, engine, cur, prevLeftover, desired, dir, fsys, log, healthSeconds, stopSeconds, keepImages, sleep, now, report }) {
  const from = cur.Config.Image, to = desired.digest, t0 = now()
  const id = `${to}@${new Date(t0).toISOString()}`
  const step = (name, more = {}) => report({ id, step: name, to, tag: desired.tag ?? null, from, at: new Date(now()).toISOString(), ...more })
  const result = (state, more = {}) => { const r = { state, from, to, tag: desired.tag ?? null, at: new Date(now()).toISOString(), seconds: Math.round((now() - t0) / 1000), ...more }; fsys.write(join(dir, 'result.json'), r); log(`[engine-updater] ${state}: ${desired.tag ?? to.slice(0, 19)}${more.reason ? ` — ${more.reason}` : ''}`); if (state !== 'switching') { const { step: failedAt, ...rest } = more; step(state, { ...rest, ...(failedAt ? { note: `at ${failedAt}` } : {}) }) } return state }
  result('switching'); step('started', { note: 'pulling the image' })
  // 1. Pull first, while the engine still answers.
  try { await docker.pull(desired.image); step('pulled') } catch (e) { return result('refused', { step: 'pull', reason: `the image could not be pulled: ${e.message}`, fix: 'check the box reaches registry.superatom.ai (curl https://registry.superatom.ai/v2/), then choose the release again' }) }
  const project = projectDir(cur)
  let stopped = false, created = null
  try {
    // 2. One engine at a time: the old one stops (a minute to finish) before the new one starts.
    await docker.stop(cur.Id, stopSeconds); stopped = true; step('stopped', { note: 'the previous engine stopped' })
    // 3. Its database, copied aside: migrations only go forward, so going back needs the copy.
    if (fsys.exists(join(project, 'db'))) fsys.copy(join(project, 'db'), join(dir, 'db-before'))
    step('db-copied')
    // 4. The new engine in its place: the same volume, settings and restart rule; only the image changes.
    if (prevLeftover) await docker.remove(prevLeftover.Id)
    await docker.rename(cur.Id, PREVIOUS(engine))
    const env = [...(cur.Config.Env ?? []).filter((e) => !e.startsWith('SA_ENGINE_IMAGE=')), `SA_ENGINE_IMAGE=${desired.image}`]
    created = await docker.create(engine, { ...pick(cur.Config, ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Labels', 'ExposedPorts', 'Volumes']), Image: desired.image, Env: env, HostConfig: cur.HostConfig })
    await docker.start(created.Id)
    step('started-new'); step('waiting', { note: `waiting up to ${healthSeconds}s for it to reach the platform` })
  } catch (e) {
    await putBack({ docker, engine, cur, created, project, dir, fsys, stopped })
    return result('rolled-back', { step: 'start', reason: e.message, fix: 'read the reason; the previous engine runs again' })
  }
  // 5. Up means: it reached the platform (it writes running.json naming its image).
  for (let waited = 0; waited < healthSeconds; waited += 2) {
    const up = fsys.read(join(dir, 'running.json'))
    if (up?.image === desired.image && Date.parse(up.at) >= t0 - 1000) {
      // 6. Kept: the old container goes, the newest images stay.
      await docker.remove(cur.Id).catch(() => {})
      await pruneImages(docker, desired.image, keepImages).catch((e) => log(`[engine-updater] old images left in place: ${e.message}`))
      return result('switched')
    }
    const st = await docker.inspect(engine).catch(() => null)
    if (st && st.State && !st.State.Running && st.State.Status === 'exited') break
    await sleep(2000)
  }
  const logTail = await docker.logs(created.Id).catch(() => '')
  await putBack({ docker, engine, cur, created, project, dir, fsys, stopped: true })
  return result('rolled-back', { step: 'health', reason: `the new engine did not reach the platform within ${healthSeconds}s`, logTail: logTail.split('\n').slice(-20).join('\n'), fix: 'read its log lines; fix and release again — the previous engine runs meanwhile' })
}

/** The previous engine back: the new one removed, the database copy restored, the old container renamed and started. */
async function putBack({ docker, engine, cur, created, project, dir, fsys, stopped }) {
  if (created) { await docker.stop(created.Id, 10).catch(() => {}); await docker.remove(created.Id).catch(() => {}) }
  if (stopped && fsys.exists(join(dir, 'db-before'))) { fsys.remove(join(project, 'db')); fsys.copy(join(dir, 'db-before'), join(project, 'db')) }
  const prev = await docker.inspect(PREVIOUS(engine))
  if (prev) await docker.rename(prev.Id, engine)
  await docker.start(cur.Id)
}

async function pruneImages(docker, keepImage, keep) {
  const repo = keepImage.slice(0, keepImage.lastIndexOf('@'))
  const mine = (await docker.images()).filter((i) => (i.RepoDigests ?? []).some((d) => d.startsWith(`${repo}@`))).sort((a, b) => b.Created - a.Created)
  for (const img of mine.slice(keep)) if (!(img.RepoDigests ?? []).includes(keepImage)) await docker.removeImage(img.Id).catch(() => {})
}

/** Each step to the platform as it happens: POST /api/projects/<id>/engine-release/progress with the project's engine key,
 *  read from the engine container's settings. Never in the way of a switch: retried three times, then logged and dropped. */
export function platformReporter(cur, log = console.log) {
  const platform = envOf(cur, 'SUPERATOM_PLATFORM'), project = envOf(cur, 'ICA_PROJECT'), key = envOf(cur, 'ICA_KEY')
  if (!platform || !project || !key) { log('[engine-updater] the engine has no platform settings — steps are kept on the box only'); return () => {} }
  const url = `https://${platform}/api/projects/${project}/engine-release/progress`
  return (body) => { void (async () => {
    for (let n = 1; n <= 3; n++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-engine-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
        if (r.ok) return
        if (r.status < 500) { log(`[engine-updater] the platform refused step ${body.step}: ${r.status} ${(await r.text()).slice(0, 200)}`); return }
      } catch { /* the network: try again */ }
      await new Promise((res) => setTimeout(res, n * 2000))
    }
    log(`[engine-updater] step ${body.step} could not be reported to the platform (kept in result.json on the box)`)
  })() }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]))
const envOf = (c, k) => (c.Config.Env ?? []).find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1)
const projectDir = (c) => envOf(c, 'ENGINE_PROJECT_DIR') ?? join('/app/data', envOf(c, 'ICA_PROJECT') ?? '')
const releaseDir = (c) => join(projectDir(c), 'engine-release')

export const defaultFs = {
  read: (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } },
  write: (f, v) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2)); renameSync(`${f}.tmp`, f) },
  exists: (f) => existsSync(f),
  copy: (a, b) => { rmSync(b, { recursive: true, force: true }); cpSync(a, b, { recursive: true }) },
  remove: (f) => rmSync(f, { recursive: true, force: true }),
}

// Run: every few seconds, forever. A failure of one look is logged and the next look tries again.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const engine = process.env.ENGINE_CONTAINER
  if (!engine) { console.error('[engine-updater] ENGINE_CONTAINER is not set — which container to look after'); process.exit(2) }
  const docker = dockerClient()
  console.log(`[engine-updater] looking after ${engine}`)
  let lastSaid = ''
  for (;;) {
    try { const what = await tick({ docker, engine }); if (what !== lastSaid && !['up-to-date', 'nothing-chosen', 'not-retried'].includes(what)) console.log(`[engine-updater] ${what}`); lastSaid = what }
    catch (e) { console.error(`[engine-updater] this look failed: ${e.message}`) }
    await new Promise((r) => setTimeout(r, 10_000))
  }
}
