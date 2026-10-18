// THE WORLD MODEL IN THE ENGINE — the one adapter between @superatom/world-model and Superatom (its DESIGN.md). The
// package's Journal is the project's journal on the platform (world:append / world:read over the hub, kept in the
// project's WorldModelDO — the truth); its Cache is a folder in the project's home here, rebuilt from the journal whenever
// it is missing. Removing the world model is removing the package and this file (and the one line that routes its replies).
//
//   const wm = createWorldModel({ send: (m) => wire.toHub(m), projectDir })
//   hub replies whose t starts with "world:" → wm.onMessage(payload)
//   const model = await wm.openModel('approvals')   → model.decide(…), model.recordOutcome(…), model.saveCache()
import { join } from 'node:path'
import { createEngine, type Engine, type Journal } from '@superatom/world-model'
import { fileCache } from '@superatom/world-model/node'

export interface WorldModelOpts {
  /** Send a message to the hub; false when it cannot be sent now (not connected). */
  send: (msg: Record<string, unknown>) => boolean
  /** The project's home on this machine: the cache lives in its world-model/ folder. */
  projectDir: string
  /** How long to wait for the platform's answer. */
  timeoutMs?: number
}

export function createWorldModel(o: WorldModelOpts) {
  const timeoutMs = o.timeoutMs ?? 30_000
  const waiting = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let n = 0

  /** One request to the platform's journal, answered by its reqId — or failed, saying why. */
  const request = (msg: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const reqId = `wm-${Date.now().toString(36)}-${++n}`
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`the platform did not answer ${String(msg.type)} in ${Math.round(timeoutMs / 1000)}s — the journal was not reached`)) }, timeoutMs)
    waiting.set(reqId, { resolve, reject, timer })
    if (!o.send({ ...msg, reqId })) { clearTimeout(timer); waiting.delete(reqId); reject(new Error('the platform is not connected — the journal cannot be reached now')) }
  })

  const journal: Journal = {
    async append(entries) { return Number((await request({ type: 'world:append', entries })).last) },
    async read(since, limit) { const r = await request({ type: 'world:read', since, ...(limit ? { limit } : {}) }); return { entries: r.entries ?? [], next: Number(r.next ?? since) } },
  }
  const cache = fileCache(join(o.projectDir, 'world-model'))
  const models = new Map<string, Promise<Engine>>()

  return {
    journal,
    /** A hub reply for the journal (t: world:appended | world:entries | world:refused). */
    onMessage(payload: Record<string, any>) {
      const w = waiting.get(String(payload.reqId ?? '')); if (!w) return
      waiting.delete(String(payload.reqId)); clearTimeout(w.timer)
      if (payload.t === 'world:refused') w.reject(new Error(String(payload.reason ?? 'the journal refused it')))
      else w.resolve(payload)
    },
    /** One model's engine, opened once per process (from the cache plus the journal after it). */
    openModel(model: string): Promise<Engine> {
      let m = models.get(model)
      if (!m) { m = createEngine({ model, journal, cache }); models.set(model, m); m.catch(() => models.delete(model)) }
      return m
    },
  }
}
