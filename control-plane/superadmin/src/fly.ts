// ── Fly: one place a project's engine can run, managed by the platform (docs/deploying-the-engine.md, "On Fly") ──
//
// A Fly machine is itself a container, so nothing is installed on it and no updater runs beside it: the platform does
// what the installer and the updater do on a machine of one's own. Per project, one Fly app — superatom-<project name> —
// holding one machine (the engine) and one volume (its data), always on (Fly restarts it if it stops). Its image is the
// release chosen for the project, from registry.fly.io/superatom-engine: every release is copied there with the same
// digest (scripts/registry-to-fly.sh), since Fly cannot sign in to another registry. A switch replaces the machine's
// image; the volume stays.
//
// Every failure says what Fly answered.

const API = 'https://api.machines.dev/v1'
export const FLY_IMAGES = 'registry.fly.io/superatom-engine'

/** Where a project's engine is on Fly. */
export interface FlyPlace { app: string; machine: string; volume: string; region: string }

async function call<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`Fly ${method} ${path}: ${res.status} ${text.slice(0, 300)}`), { status: res.status })
  return (text ? JSON.parse(text) : null) as T
}

/** Does Fly's registry hold this release? */
export async function flyHasImage(token: string, digest: string): Promise<boolean> {
  const res = await fetch(`https://registry.fly.io/v2/superatom-engine/manifests/${digest}`, {
    method: 'HEAD', headers: { authorization: `Basic ${btoa(`x:${token}`)}`, accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' } })
  return res.ok
}

export const slugOf = (name: string | null | undefined) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** The engine on Fly — made, or brought to this image and these settings if it is there already (its volume kept). */
export async function flyPlace(token: string, o: { org: string; project: string; name: string | null; region: string; image: string; env: Record<string, string>; was?: FlyPlace | null }): Promise<FlyPlace> {
  // 1. The app: the one this project had, else superatom-<name> (its id beside the name when another holds that name).
  const slug = slugOf(o.name) || o.project.slice(0, 8)
  let app = o.was?.app ?? ''
  if (!app) {
    for (const name of [`superatom-${slug}`, `superatom-${slug}-${o.project.slice(0, 8)}`]) {
      const mine = await call(token, 'GET', `/apps/${name}`).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)))
      if (mine) { app = name; break }   // ours already (a token sees only its own organisation's apps)
      const made = await call(token, 'POST', '/apps', { app_name: name, org_slug: o.org }).then(() => true, (e) => (e.status === 422 || e.status === 409 ? false : Promise.reject(e)))
      if (made) { app = name; break }
    }
    if (!app) throw new Error(`Fly would not make an app named superatom-${slug} or superatom-${slug}-${o.project.slice(0, 8)}`)
  }
  // 2. Its volume: the one it has, else a new one. Engine state is small; Fly bills the size provisioned.
  const vols = (await call<any[]>(token, 'GET', `/apps/${app}/volumes`)).filter((v) => v.state !== 'destroyed' && v.state !== 'pending_destroy')
  const vol = vols.find((v) => v.id === o.was?.volume) ?? vols[0]
    ?? await call(token, 'POST', `/apps/${app}/volumes`, { name: 'data', region: o.region, size_gb: 10, encrypted: true })
  // 3. The machine, beside its volume (a volume lives in one region).
  const config = { image: o.image, env: o.env, guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 }, mounts: [{ volume: vol.id, path: '/app/data' }], restart: { policy: 'always' } }
  const machines = (await call<any[]>(token, 'GET', `/apps/${app}/machines`)).filter((m) => m.state !== 'destroyed')
  const m = machines[0]
    ? await call(token, 'POST', `/apps/${app}/machines/${machines[0].id}`, { config })
    : await call(token, 'POST', `/apps/${app}/machines`, { name: 'engine', region: vol.region, config })
  return { app, machine: m.id, volume: vol.id, region: vol.region }
}

/** The engine's machine on another image (Fly stops it, swaps the image, starts it); what it ran before is returned. */
export async function flySetImage(token: string, p: FlyPlace, image: string): Promise<string> {
  const m = await call(token, 'GET', `/apps/${p.app}/machines/${p.machine}`)
  const before = String(m.config?.image ?? '')
  await call(token, 'POST', `/apps/${p.app}/machines/${p.machine}`, { config: { ...m.config, image, env: { ...(m.config?.env ?? {}), SA_ENGINE_IMAGE: image } } })
  return before
}

/** What Fly says about the machine now. */
export async function flyMachine(token: string, p: FlyPlace): Promise<{ state: string; region: string; image: string; cpus?: number; memoryMb?: number }> {
  const m = await call(token, 'GET', `/apps/${p.app}/machines/${p.machine}`)
  return { state: m.state, region: m.region, image: m.config?.image ?? '', cpus: m.config?.guest?.cpus, memoryMb: m.config?.guest?.memory_mb }
}

/** The engine leaves Fly: its machine is removed; the app and its volume (the engine's data) stay, for a return. */
export async function flyRemoveMachine(token: string, p: FlyPlace): Promise<void> {
  await call(token, 'DELETE', `/apps/${p.app}/machines/${p.machine}?force=true`).catch((e) => (e.status === 404 ? null : Promise.reject(e)))
}

/** Idle: suspended (CPU and memory no longer billed; it wakes warm, in a second or two), stopped (a cold start), started. */
export async function flySuspend(token: string, p: FlyPlace): Promise<void> { await call(token, 'POST', `/apps/${p.app}/machines/${p.machine}/suspend`) }
export async function flyStop(token: string, p: FlyPlace): Promise<void> { await call(token, 'POST', `/apps/${p.app}/machines/${p.machine}/stop`) }
export async function flyStart(token: string, p: FlyPlace): Promise<void> { await call(token, 'POST', `/apps/${p.app}/machines/${p.machine}/start`) }
