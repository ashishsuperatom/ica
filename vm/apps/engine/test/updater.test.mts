// The box's updater (apps/updater): every way a switch can go, against a fake Docker and a fake disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore — plain JavaScript, no types
import { tick, settleSelf, refreshSelf } from '../../updater/updater.mjs'

const OLD = 'registry.superatom.ai/superatom-engine@sha256:' + 'a'.repeat(64)
const NEW = 'registry.superatom.ai/superatom-engine@sha256:' + 'b'.repeat(64)
const DIR = '/app/data/p1/engine-release'

function world(o: { pullFails?: boolean; comesUp?: boolean; crashes?: boolean } = {}) {
  const files = new Map<string, any>([[`${DIR}/desired.json`, { digest: NEW.split('@')[1], tag: 'dev-2', image: NEW }], ['/app/data/p1/db', 'live-db']])
  const containers = new Map<string, any>()
  let n = 0
  const mk = (name: string, image: string) => { const c = { Id: `c${++n}`, Name: name, Config: { Image: image, Env: ['ICA_PROJECT=p1', 'ENGINE_PROJECT_DIR=/app/data/p1'] }, HostConfig: { Binds: ['vol:/app/data'] }, State: { Running: false, Status: 'created' } }; containers.set(name, c); return c }
  mk('sa-engine-p1', OLD).State = { Running: true, Status: 'running' }
  const byId = (id: string) => [...containers.values()].find((c) => c.Id === id)
  const log: string[] = []
  const docker = {
    inspect: async (name: string) => containers.get(name) ?? null,
    pull: async () => { if (o.pullFails) throw new Error('unauthorized') },
    stop: async (id: string) => { log.push(`stop ${id}`); const c = byId(id); if (c) c.State = { Running: false, Status: 'exited' } },
    start: async (id: string) => { log.push(`start ${id}`); const c = byId(id)!; c.State = { Running: true, Status: 'running' }
      if (c.Config.Image === NEW && o.comesUp) files.set(`${DIR}/running.json`, { image: NEW, at: new Date().toISOString() })
      if (c.Config.Image === NEW && o.crashes) c.State = { Running: false, Status: 'exited' } },
    rename: async (id: string, name: string) => { const c = byId(id)!; containers.delete(c.Name); c.Name = name; containers.set(name, c) },
    remove: async (id: string) => { const c = byId(id); if (c) containers.delete(c.Name); log.push(`remove ${id}`) },
    create: async (name: string, spec: any) => { const c = mk(name, spec.Image); c.Config.Env = spec.Env; return { Id: c.Id } },
    logs: async () => 'boom: cannot connect',
    images: async () => [], removeImage: async () => {},
    hostName: async () => 'box-1',
  }
  const fsys = {
    read: (f: string) => files.get(f) ?? null, write: (f: string, v: any) => files.set(f, v), exists: (f: string) => files.has(f),
    copy: (a: string, b: string) => files.set(b, files.get(a)), remove: (f: string) => files.delete(f),
  }
  const steps: string[] = []
  const run = () => tick({ docker, engine: 'sa-engine-p1', fsys, log: () => {}, healthSeconds: 6, sleep: async () => {}, report: (b: any) => steps.push(b.step) })
  return { run, files, containers, log, steps }
}

test('a chosen release is pulled, the old engine stopped, the new started and kept once it reaches the platform', async () => {
  const w = world({ comesUp: true })
  assert.equal(await w.run(), 'switched')
  const eng = w.containers.get('sa-engine-p1')
  assert.equal(eng.Config.Image, NEW)
  assert.ok(eng.Config.Env.includes(`SA_ENGINE_IMAGE=${NEW}`))
  assert.ok(eng.Config.Env.includes('SA_HOST_NAME=box-1'))   // the machine's own name, asked of Docker, for the engine to report
  assert.equal(w.containers.has('sa-engine-p1-previous'), false)
  assert.equal(w.files.get(`${DIR}/result.json`).state, 'switched')
  assert.equal(w.files.get(`${DIR}/db-before`), 'live-db')
  assert.deepEqual(w.steps, ['started', 'pulled', 'stopped', 'db-copied', 'started-new', 'waiting', 'switched'])
  assert.equal(await w.run(), 'up-to-date')
})

test('an image that cannot be pulled changes nothing: refused, and the engine never stopped', async () => {
  const w = world({ pullFails: true })
  assert.equal(await w.run(), 'refused')
  assert.equal(w.containers.get('sa-engine-p1').Config.Image, OLD)
  assert.deepEqual(w.log, [])
  assert.match(w.files.get(`${DIR}/result.json`).reason, /unauthorized/)
  assert.deepEqual(w.steps, ['started', 'refused'])
})

test('a new engine that never reaches the platform is rolled back: database restored, previous engine running, reason kept', async () => {
  const w = world({ comesUp: false })
  w.files.set('/app/data/p1/db', 'live-db')
  const original = w.containers.get('sa-engine-p1').Id
  assert.equal(await w.run(), 'rolled-back')
  const eng = w.containers.get('sa-engine-p1')
  assert.equal(eng.Id, original); assert.equal(eng.Config.Image, OLD); assert.equal(eng.State.Running, true)
  assert.equal(w.files.get('/app/data/p1/db'), 'live-db')
  const r = w.files.get(`${DIR}/result.json`)
  assert.equal(r.step, 'health'); assert.match(r.logTail, /boom/)
  assert.equal(w.steps.at(-1), 'rolled-back')
  // …and the same release is not tried again — until someone chooses it again.
  assert.equal(await w.run(), 'not-retried')
  w.files.set(`${DIR}/desired.json`, { ...w.files.get(`${DIR}/desired.json`), chosenAt: new Date(Date.now() + 1000).toISOString() })
  assert.equal(await w.run(), 'rolled-back')
})

test('a new engine that crashes at once is rolled back without waiting out the window', async () => {
  const w = world({ crashes: true })
  assert.equal(await w.run(), 'rolled-back')
  assert.equal(w.containers.get('sa-engine-p1').Config.Image, OLD)
})

test('a switch cut short (the engine gone, the previous set aside) is put back on the next look', async () => {
  const w = world()
  const c = w.containers.get('sa-engine-p1'); w.containers.delete('sa-engine-p1'); c.Name = 'sa-engine-p1-previous'; w.containers.set(c.Name, c)
  assert.equal(await w.run(), 'recovered')
  assert.equal(w.containers.get('sa-engine-p1').Id, c.Id)
})

// ── The updater keeps itself current ──
/** A box: the engine (on `engineImage`) and its updater (on `updaterImage`, id u1); `takesOver` says whether a successor started
 *  here does what a new updater does at start (settleSelf). */
function box(o: { engineImage: string; updaterImage: string; engineRunning?: boolean; takesOver?: boolean }) {
  const containers = new Map<string, any>()
  let n = 0
  const mk = (name: string, spec: any) => { const c = { Id: `c${++n}`, Name: `/${name}`, Config: { Image: spec.Image, Env: spec.Env ?? [], Entrypoint: spec.Entrypoint, Cmd: spec.Cmd, Labels: spec.Labels }, HostConfig: spec.HostConfig ?? {}, State: { Running: false } }; containers.set(name, c); return c }
  mk('sa-engine-p1', { Image: o.engineImage }).State.Running = o.engineRunning ?? true
  const upd = mk('sa-engine-updater-p1', { Image: o.updaterImage, Env: ['ENGINE_CONTAINER=sa-engine-p1'], Entrypoint: ['node'], Cmd: ['/app/apps/updater/updater.mjs'], HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'vol:/app/data'], RestartPolicy: { Name: 'unless-stopped' } } })
  upd.Id = 'u1'; upd.State.Running = true
  const find = (ref: string) => containers.get(ref) ?? [...containers.values()].find((c) => c.Id === ref) ?? null
  const docker: any = {
    inspect: async (ref: string) => find(ref),
    create: async (name: string, spec: any) => ({ Id: mk(name, spec).Id }),
    start: async (id: string) => { const c = find(id)!; c.State.Running = true
      if (o.takesOver && c.Name.endsWith('-next')) await settleSelf({ docker, self: c.Id, log: () => {} }) },   // the new updater, starting
    remove: async (id: string) => { const c = find(id); if (c) containers.delete(c.Name.slice(1)) },
    rename: async (id: string, name: string) => { const c = find(id)!; containers.delete(c.Name.slice(1)); c.Name = `/${name}`; containers.set(name, c) },
    logs: async () => 'cannot start',
  }
  return { docker, containers }
}

test('the engine on a release the updater is not: its successor starts on that image with its settings, removes it and takes its name', async () => {
  const b = box({ engineImage: NEW, updaterImage: OLD, takesOver: true })
  assert.equal(await refreshSelf({ docker: b.docker, engine: 'sa-engine-p1', self: 'u1', log: () => {}, sleep: async () => {} }), 'handed-over')
  const u = b.containers.get('sa-engine-updater-p1')
  assert.equal(u.Config.Image, NEW)                                         // the updater runs the engine's release now
  assert.notEqual(u.Id, 'u1')                                               // a new container: the old one is gone
  assert.deepEqual(u.Config.Env, ['ENGINE_CONTAINER=sa-engine-p1'])         // with the same settings
  assert.deepEqual(u.HostConfig.Binds, ['/var/run/docker.sock:/var/run/docker.sock', 'vol:/app/data'])
  assert.equal(b.containers.has('sa-engine-updater-p1-next'), false)
  assert.equal([...b.containers.keys()].length, 2)                           // never two updaters left behind
})

test('nothing to do while the updater already runs the engine\'s release, or the engine is not running', async () => {
  const same = box({ engineImage: NEW, updaterImage: NEW })
  assert.equal(await refreshSelf({ docker: same.docker, engine: 'sa-engine-p1', self: 'u1', log: () => {} }), 'current')
  const stopped = box({ engineImage: NEW, updaterImage: OLD, engineRunning: false })
  assert.equal(await refreshSelf({ docker: stopped.docker, engine: 'sa-engine-p1', self: 'u1', log: () => {} }), 'nothing-to-do')
  assert.equal(stopped.containers.has('sa-engine-updater-p1-next'), false)
})

test('a successor that never takes over is removed, this updater keeps running, and that release is not tried again', async () => {
  const b = box({ engineImage: NEW, updaterImage: OLD, takesOver: false })
  const failed = new Set<string>()
  assert.equal(await refreshSelf({ docker: b.docker, engine: 'sa-engine-p1', self: 'u1', log: () => {}, sleep: async () => {}, takeoverSeconds: 6, failed }), 'not-taken-over')
  assert.equal(b.containers.has('sa-engine-updater-p1-next'), false)
  assert.equal(b.containers.get('sa-engine-updater-p1').Id, 'u1')
  assert.equal(await refreshSelf({ docker: b.docker, engine: 'sa-engine-p1', self: 'u1', log: () => {}, failed }), 'current')
})

test('at start, a successor left by a failed attempt is removed', async () => {
  const b = box({ engineImage: NEW, updaterImage: OLD })
  await b.docker.create('sa-engine-updater-p1-next', { Image: NEW })
  assert.equal(await settleSelf({ docker: b.docker, self: 'u1', log: () => {} }), 'leftover-removed')
  assert.equal(b.containers.has('sa-engine-updater-p1-next'), false)
})
