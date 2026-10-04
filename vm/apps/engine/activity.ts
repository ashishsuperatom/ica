// WORK IN THE BACKGROUND, VISIBLE. Anything the engine does that takes a while — building a program, running a session's
// programs, and later the builder agent's work — is an ACTIVITY: what it is, whose it is, where it stands (running,
// done, failed) and how far along. The hub keeps each activity's latest state and sends it to its owner (and the
// project's admins), so a person who connects in the middle still sees what is running.

export interface Activity { id: string; owner: string; kind: string; title: string; state: 'running' | 'done' | 'failed'; progress?: string; detail?: string; startedAt: string; updatedAt: string }

export function createActivities(o: { send: (msg: Record<string, unknown>) => boolean }) {
  let n = 0
  const post = (a: Activity) => { o.send({ type: 'activity', activity: a }) }
  /** Start an activity for its owner; returns how to report on it. Reporting never throws: visibility must not break the work. */
  function start(owner: string, kind: string, title: string) {
    const now = new Date().toISOString()
    const a: Activity = { id: `act_${Date.now().toString(36)}${(n++).toString(36)}`, owner, kind, title, state: 'running', startedAt: now, updatedAt: now }
    const update = (patch: Partial<Activity>) => { Object.assign(a, patch, { updatedAt: new Date().toISOString() }); try { post({ ...a }) } catch { /* not visible, still done */ } }
    update({})
    return {
      id: a.id,
      progress: (text: string) => update({ progress: text }),
      done: (detail?: string) => update({ state: 'done', ...(detail ? { detail } : {}) }),
      failed: (detail: string) => update({ state: 'failed', detail }),
    }
  }
  /** Run work as an activity: running while it runs, then done or failed with the reason. */
  async function around<T>(owner: string, kind: string, title: string, work: (a: ReturnType<typeof start>) => Promise<T>, summary?: (r: T) => string): Promise<T> {
    const a = start(owner, kind, title)
    try { const r = await work(a); a.done(summary?.(r)); return r }
    catch (e: any) { a.failed(e?.message ?? String(e)); throw e }
  }
  return { start, around }
}
