// Development environments, as the project keeps them (docs/dev-mode.md): one row each — who, its name, what it
// overrides, when it was made and last used, whether it is attached — and, while attached, the overrides the engine
// needs, stamped on every message from its owner. Every change is a request (create, attach, detach, delete); the
// engine is told to let an environment's builds go when it ends. An environment is never deleted for being unused; one
// left without sacli for an hour is detached (its owner sees what is published again) and stays to resume.

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

export interface Overrides { programs: Record<string, string>; agents: Record<string, Record<string, unknown>>; map?: unknown }
export interface DevEnv { id: string; name: string; owner: string; status: 'attached' | 'detached' | 'deleted'; names: string[]; created_at: string; last_used: string }
export class DevRefusal extends Error {}

/** An hour without sacli: the same hour as sacli's own background connection. */
export const DETACH_AFTER_MS = 60 * 60_000

export class DevEnvs {
  constructor(private sql: Sql, private clearOnEngine: (env: string) => void, private now: () => number = Date.now) {}
  /** Told whenever a person's environment ends (detached, deleted, or detached for an hour without sacli). */
  onEnd: ((owner: string) => void) | null = null

  private row = (r: Record<string, unknown>): DevEnv => ({ id: String(r.id), name: String(r.name), owner: String(r.owner), status: r.status as DevEnv['status'],
    names: JSON.parse(String(r.names ?? '[]')), created_at: new Date(Number(r.created_at)).toISOString(), last_used: new Date(Number(r.last_used)).toISOString() })
  private get(id: string): (DevEnv & { overrides: Overrides | null; seen: number }) | null {
    const [r] = [...this.sql.exec('SELECT * FROM dev_envs WHERE id = ?', id)]
    return r ? { ...this.row(r), overrides: r.overrides ? JSON.parse(String(r.overrides)) : null, seen: Number(r.last_used) } : null
  }
  private mine(id: unknown, owner: string) {
    const e = typeof id === 'string' ? this.get(id) : null
    if (!e || e.status === 'deleted') throw new DevRefusal(`there is no environment ${String(id)}`)
    if (e.owner !== owner) throw new DevRefusal(`environment ${e.name} is ${e.owner}'s`)
    return e
  }
  private end(e: { id: string; owner: string }, status: 'detached' | 'deleted') {
    this.sql.exec('UPDATE dev_envs SET status = ?, overrides = NULL WHERE id = ?', status, e.id)
    this.clearOnEngine(e.id)
    this.onEnd?.(e.owner)
  }
  /** The environment a person is attached to now, if any — what their browser shows. */
  attachedOf(owner: string | null): DevEnv | null {
    if (!owner) return null
    const [r] = [...this.sql.exec("SELECT * FROM dev_envs WHERE owner = ? AND status = 'attached'", owner)]
    return r ? this.row(r) : null
  }

  /** The people's list (project admins), or one person's. */
  list(owner: string | null): DevEnv[] {
    const rows = owner ? this.sql.exec("SELECT * FROM dev_envs WHERE owner = ? AND status != 'deleted' ORDER BY last_used DESC", owner) : this.sql.exec("SELECT * FROM dev_envs WHERE status != 'deleted' ORDER BY last_used DESC")
    return [...rows].map(this.row)
  }
  create(owner: string, name: string): DevEnv {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new DevRefusal('an environment is named in lower-case letters, digits and dashes')
    if ([...this.sql.exec("SELECT 1 FROM dev_envs WHERE owner = ? AND name = ? AND status != 'deleted'", owner, name)].length) throw new DevRefusal(`you have an environment named ${name} already — attach to it`)
    const id = `dv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, t = this.now()
    this.sql.exec("INSERT INTO dev_envs (id, name, owner, status, names, created_at, last_used) VALUES (?, ?, ?, 'detached', '[]', ?, ?)", id, name, owner, t, t)
    return this.row([...this.sql.exec('SELECT * FROM dev_envs WHERE id = ?', id)][0])
  }
  /** Attach (or, attached, update what it overrides). A person is attached to one environment at a time in a project. */
  attach(owner: string, id: unknown, overrides: unknown): DevEnv {
    const e = this.mine(id, owner)
    const o = checkOverrides(overrides)
    for (const other of this.list(owner)) if (other.status === 'attached' && other.id !== e.id) this.end(other, 'detached')
    const names = [...Object.keys(o.programs).map((n) => `program ${n}`), ...Object.keys(o.agents).map((n) => `agent ${n}`), ...(o.map !== undefined ? ['map'] : [])]
    this.sql.exec("UPDATE dev_envs SET status = 'attached', overrides = ?, names = ?, last_used = ? WHERE id = ?", JSON.stringify(o), JSON.stringify(names), this.now(), e.id)
    return this.row([...this.sql.exec('SELECT * FROM dev_envs WHERE id = ?', e.id)][0])
  }
  /** sacli dev is still there. */
  ping(owner: string, id: unknown): void { const e = this.mine(id, owner); this.sql.exec('UPDATE dev_envs SET last_used = ? WHERE id = ?', this.now(), e.id) }
  detach(owner: string, id: unknown): void { const e = this.mine(id, owner); if (e.status === 'attached') this.end(e, 'detached') }
  delete(owner: string, id: unknown, admin = false): void {
    const e = typeof id === 'string' ? this.get(id) : null
    if (!e || e.status === 'deleted') throw new DevRefusal(`there is no environment ${String(id)}`)
    if (e.owner !== owner && !admin) throw new DevRefusal(`environment ${e.name} is ${e.owner}'s`)
    this.end(e, 'deleted')
  }

  /** What to stamp on a message from this person: their attached environment's overrides — unless sacli has been gone
   *  an hour, when it is detached instead (they see what is published again). */
  overlayFor(owner: string | null): (Overrides & { id: string }) | null {
    if (!owner) return null
    const [r] = [...this.sql.exec("SELECT id, overrides, last_used FROM dev_envs WHERE owner = ? AND status = 'attached'", owner)]
    if (!r) return null
    if (this.now() - Number(r.last_used) > DETACH_AFTER_MS) { this.end({ id: String(r.id), owner }, 'detached'); return null }
    return { id: String(r.id), ...(JSON.parse(String(r.overrides ?? '{"programs":{},"agents":{}}')) as Overrides) }
  }
}

/** What an environment may override, checked: builds by hash, agents and the map as bodies. */
export function checkOverrides(v: unknown): Overrides {
  const o = (v ?? {}) as Record<string, any>
  const programs: Record<string, string> = {}, agents: Record<string, Record<string, unknown>> = {}
  for (const [n, h] of Object.entries(o.programs ?? {})) { if (!/^[\w-]+$/.test(n) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) throw new DevRefusal(`program ${n}: a build is named by its hash`); programs[n] = h }
  for (const [n, b] of Object.entries(o.agents ?? {})) { if (!/^[\w-]+$/.test(n) || !b || typeof b !== 'object' || Array.isArray(b)) throw new DevRefusal(`agent ${n}: its body is an object`); agents[n] = b as Record<string, unknown> }
  if (JSON.stringify({ programs, agents, map: o.map }).length > 512 * 1024) throw new DevRefusal('an environment overrides at most 512 KB of agents and map')
  return { programs, agents, ...(o.map !== undefined && o.map !== null ? { map: o.map } : {}) }
}
