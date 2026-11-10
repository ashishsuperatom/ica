// A PERSON'S CELL — an engine doing one person's work in one project (the engine in cell mode, vm/apps/engine/mode.ts). It
// links through the person's door, this UserDO, never to the project directly: it comes in as a key's socket would
// (/_ws/<project>?agent=1&person=<id>), with the person's key for that project in its hello, saying it is a cell. Its key
// is checked here, like any key of theirs; the project is told only which key, whose, and which engine — and admits it as
// that person's cell (ProjectDO personLink, surface 'cell'): any number may connect, one is the person's primary, as with
// engines. Everything the project sends that link goes to the cell; nothing of it enters the person's inbox.

/** Which engine a cell is: the same id an engine keeps on its disk for good. */
const ENGINE_ID = /^[A-Za-z0-9_-]{8,80}$/

/** What a cell says of itself in its hello, as the project's engine would (which engine, which process, which models). */
export interface CellHello { engineId: string; instanceId?: string; epoch?: number; host?: string; modelsHash?: string }

/** A hello that says it is a cell: what it says of itself, or why it cannot be one. */
export function cellOf(msg: any): CellHello | { error: string } {
  const engineId = typeof msg?.engineId === 'string' && ENGINE_ID.test(msg.engineId) ? msg.engineId : null
  if (!engineId) return { error: 'a cell says which engine it is (its engineId) — update it to a release that does' }
  return {
    engineId,
    ...(typeof msg.instanceId === 'string' ? { instanceId: msg.instanceId.slice(0, 80) } : {}),
    ...(typeof msg.epoch === 'number' ? { epoch: msg.epoch } : {}),
    ...(typeof msg.host === 'string' ? { host: msg.host.slice(0, 100) } : {}),
    ...(typeof msg.modelsHash === 'string' ? { modelsHash: msg.modelsHash.slice(0, 80) } : {}),
  }
}
