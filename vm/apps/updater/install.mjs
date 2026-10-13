// ── The Superatom Engine installer: a project's engine and its updater, started on this machine ──
//
// Run by get.superatom.site/engine/install.sh, from the engine's own image, with the Docker socket — so a machine that only
// runs an engine needs nothing but Docker (no sacli, no Node). With a key of the project's (project.manage), used here
// once and never kept on the machine, it:
//   1. asks the platform for what the engine connects with (its engine key, the hub) and the release chosen for the project
//   2. pulls that release by its digest (the exact bytes; else the newest dev build)
//   3. starts the engine (sa-engine-<project>, its data on the volume of that name, restarted unless stopped) and, beside
//      it, the updater (sa-engine-updater-<project>), which from then on switches it to whatever release is chosen
//   4. waits for the engine to reach the platform
// Again on the same machine: nothing changes when both run the chosen release; otherwise they are made again on the same
// volume. Every failure says what failed and what to do.
import { dockerClient } from './updater.mjs'

const fail = (what, fix) => { console.error(`✗ ${what}\n  → ${fix}`); process.exit(1) }
const say = (s) => console.log(s)
const key = process.env.SUPERATOM_KEY ?? ''
const platform = (process.env.SUPERATOM_PLATFORM || 'https://superatom.site').replace(/\/$/, '')
const pid = /^sak_([0-9a-f-]{36})_/.exec(key)?.[1]
if (!pid) fail('no project key given', 'run: curl -fsSL https://get.superatom.site/engine/install.sh | sh -s -- <the project\'s key> (make one in the admin console: the project → Agent keys, with project.manage)')

const api = async (path) => {
  const r = await fetch(`${platform}/api/projects/${pid}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
    .catch((e) => fail(`cannot reach ${platform} (${e.message})`, 'check this machine reaches superatom.site (curl -I https://superatom.site)'))
  if (r.status === 401 || r.status === 403) fail(`the key was refused (${r.status})`, 'use a key of this project holding project.manage, still in force')
  if (!r.ok) fail(`${platform} answered ${r.status} for ${path}`, 'try again in a minute; if it persists, tell us the line above')
  return r.json()
}

const docker = dockerClient()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. What it connects with, and which release.
const c = await api('/engine-credentials')
// Named after the project — superatom-<name> (the engine), superatom-<name>-updater, superatom-<name>-data (its volume) —
// and labelled with the project's id and each one's role, which is how they are found again (whatever an older install
// named them). A name another project already has here gets the project's id beside it.
const slug = String(c.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || pid.slice(0, 8)
const mine = (x) => x?.Config?.Labels?.['superatom.project'] === pid
const base = (await docker.inspect(`superatom-${slug}`).then((x) => (x && !mine(x) ? `superatom-${slug}-${pid.slice(0, 8)}` : `superatom-${slug}`)))
const ours = (await docker.list(pid)) ?? []
const roleOf = (x) => x.Labels?.['superatom.role'] ?? (/updater/.test(x.Names?.[0] ?? '') ? 'updater' : 'engine')
const oldEngine = ours.find((x) => roleOf(x) === 'engine'), oldUpdater = ours.find((x) => roleOf(x) === 'updater')
const engine = base, updater = `${base}-updater`
// The engine's data stays where it was: the volume an earlier engine of this project used, else a new one.
const volume = oldEngine?.Mounts?.find((m) => m.Destination === '/app/data')?.Name ?? `${base}-data`
const rel = await api('/engine-release').catch(() => null)
const repo = 'registry.superatom.ai/superatom-engine'
let image = rel?.desired?.digest ? `${repo}@${rel.desired.digest}` : null
say(`project ${c.name ?? pid}${image ? ` · release ${rel.desired.tag ?? image.slice(-19)}` : ' · no release chosen yet: the newest dev build'}`)

// 2. Pulled by its digest: the chosen release's, else the newest dev build's (read from the registry: the SHA-256 of the
//    manifest the name points at), so what runs is always the exact bytes.
if (!image) {
  const r = await fetch(`https://${repo.replace('/', '/v2/')}/manifests/dev`, { headers: { accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(30_000) })
    .catch((e) => fail(`cannot reach registry.superatom.ai (${e.message})`, 'check this machine reaches it (curl https://registry.superatom.ai/v2/)'))
  if (!r.ok) fail(`registry.superatom.ai has no dev release (${r.status})`, 'choose a release for the project in the admin console (Engine → Engine version), then run this again')
  const { createHash } = await import('node:crypto')
  image = `${repo}@sha256:${createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')}`
}
say(`pulling ${image.slice(0, 60)}…`)
await docker.pull(image).catch((e) => fail(`could not pull the release (${e.message})`, 'check this machine reaches registry.superatom.ai (curl https://registry.superatom.ai/v2/), then run this again'))

// 3. The engine and its updater, made again only when they do not run the chosen release.
const env = Object.entries({
  ICA_PROJECT: c.project, ICA_KEY: c.engineKey, ICA_HUB: c.hub, SUPERATOM_PLATFORM: c.platform,
  ...(c.name ? { PROJECT_NAME: String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) } : {}),
  SUPERATOM_HOME: '/app/data', DATASOURCE_URL: 'http://localhost:4000', DATASOURCE_DATA_DIR: '/app/data/datasources', DATASOURCES_DIR: '/app/data/datasources',
  SA_ENGINE_IMAGE: image,
}).map(([k, v]) => `${k}=${v}`)
const labels = (role) => ({ 'superatom.project': pid, 'superatom.role': role })
const cur = oldEngine ? await docker.inspect(oldEngine.Id) : null
if (cur?.State?.Running && cur.Config.Image === image && cur.Name === `/${engine}`) say(`${engine} already runs this release`)
else {
  if (oldUpdater) await docker.remove(oldUpdater.Id)   // the updater first: never a switch half-way through this
  if (cur) await docker.remove(cur.Id)
  const made = await docker.create(engine, { Image: image, Env: env, Labels: labels('engine'), HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Binds: [`${volume}:/app/data`] } })
  await docker.start(made.Id)
  say(`started ${engine} — its data on the volume ${volume}`)
}
const up = await docker.inspect(updater)
if (!(up?.State?.Running && up.Config.Image === image)) {
  if (up) await docker.remove(up.Id)
  const made = await docker.create(updater, { Image: image, Entrypoint: ['node'], Cmd: ['/app/apps/updater/updater.mjs'], Env: [`ENGINE_CONTAINER=${engine}`], Labels: labels('updater'),
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Binds: ['/var/run/docker.sock:/var/run/docker.sock', `${volume}:/app/data`] } })
  await docker.start(made.Id)
  say(`started ${updater} — it switches the engine whenever another release is chosen (the admin console: Engine → Engine version)`)
}

// 4. Reached the platform?
say('waiting for the engine to reach the platform…')
for (let i = 0; i < 90; i++) {
  const s = await api('/status').catch(() => null)
  if ((s?.connections ?? []).some((x) => x.type === 'code-engine')) { say(`✓ the engine of ${c.name ?? pid} is connected. Done — nothing else to run on this machine.`); process.exit(0) }
  await sleep(2000)
}
fail('the engine did not reach the platform in 3 minutes', `docker logs ${engine} --tail 40 — then run this again`)
