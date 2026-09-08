// Fly Machines API client — used by the Worker to manage project VMs
//
// One Fly App contains one Machine per project.
// Machines are created on project creation, started on user connection,
// stopped after idle timeout, and destroyed on project deletion.

export interface MachineConfig {
  projectId: string
  apiKey: string             // per-project key for WS auth
  workerWsHost: string       // e.g. "superatom.example.com"
  platform?: string          // the vault/proxy domain; defaults to workerWsHost
  claudeOAuthToken?: string  // Claude subscription token
  flyAppName?: string        // defaults to FLY_APP
  flyOrgSlug?: string        // org slug
  region?: string            // defaults to "ord"
}

export interface MachineInfo {
  id: string
  name: string
  state: 'created' | 'starting' | 'started' | 'stopping' | 'stopped' | 'destroying' | 'destroyed' | 'suspended'
  volumeId?: string
}

const FLY_API = 'https://api.machines.dev/v1'

// Fly naming rules: lowercase alphanumeric + underscores, max 30 chars
export function safeName(prefix: string, projectId: string): string {
  const clean = projectId.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '')
  return `${prefix}_${clean}`.slice(0, 30)
}

function headers(token: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function flyRequest(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${FLY_API}${path}`, {
    ...init,
    headers: { ...headers(token), ...(init?.headers as Record<string, string> || {}) },
  })
}

// ── Create machine (on project creation) ──────────────────────────────────────

// Resolve the app's current deployed image via Fly GraphQL API (the REST
// v1/apps endpoint doesn't include image info; only GraphQL has currentRelease).
// THE app. It was written in three places and the default here was a DIFFERENT name than the one that exists,
// so any caller that omitted the argument would have talked to an app that is not there — and silently, since
// Fly answers 404 and a wake just never happens. One constant, and the defaults point at it.
export const FLY_APP = 'superatom-code-engine-vm'

export async function getAppImage(token: string, appName: string): Promise<string> {
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `{ app(name:"${appName}") { currentRelease { imageRef } } }`,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly GraphQL get app failed (${res.status}): ${body}`)
  }
  const { data } = await res.json() as any
  const image = data?.app?.currentRelease?.imageRef
  if (!image) throw new Error(`No current release image found for app ${appName}. Deploy the app first with: flyctl deploy`)
  return image
}

export async function createMachine(token: string, config: MachineConfig): Promise<MachineInfo> {
  const appName = config.flyAppName || FLY_APP
  const region = config.region || 'ord'
  const machineName = safeName('proj', config.projectId)

  // Resolve the current deployed image
  const image = await getAppImage(token, appName)

  // 1. Create a dedicated volume for this machine
  const volName = safeName('data', config.projectId)
  const volRes = await flyRequest(token, `/apps/${appName}/volumes`, {
    method: 'POST',
    body: JSON.stringify({
      name: volName,
      region,
      // Engine state is tiny (~1.6GB observed: ~170MB real state + agent-home caches). 10GB is ~6x headroom
      // and the OS runs on the machine's separate rootfs, not this volume. Fly bills provisioned size, so
      // don't over-allocate — a volume can be extended later if a project ever genuinely needs it.
      size_gb: 10,
      encrypted: true,
    }),
  })
  if (!volRes.ok) {
    const body = await volRes.text()
    throw new Error(`Fly create volume failed (${volRes.status}): ${body}`)
  }
  const vol = await volRes.json() as any
  console.log(`[fly] created volume ${vol.id} (${volName})`)

  // 2. Create the machine with that volume
  const res = await flyRequest(token, `/apps/${appName}/machines`, {
    method: 'POST',
    body: JSON.stringify({
      name: machineName,
      region,
      config: {
        image,
        guest: {
          cpu_kind: 'shared',
          cpus: 2,
          memory_mb: 4096,
        },
        env: {
          // The engine's real env contract (see vm/apps/engine/engine.ts). ICA_HUB is the BASE only — the
          // engine appends /_ws/<project>?key=<key> itself (passing the full URL would double it).
          ICA_PROJECT: config.projectId,
          ICA_KEY: config.apiKey,
          ICA_HUB: `wss://${config.workerWsHost}`,
          DATASOURCE_URL: 'http://localhost:4000',
          // claude-code refuses --dangerously-skip-permissions as root unless told it's sandboxed; a Fly
          // Machine (Firecracker microVM) is one, so the analyst/connector/modeller can run as root.
          IS_SANDBOX: '1',
          // Persistence + the datasource registry live on the mounted VOLUME so they survive machine restarts.
          // ONE state root: the workspace (seams, programs, out) and the project's DBs (project/grounding/
          // answers) co-locate under /app/data/state/<project>. (The engine derives WORKSPACE_ROOT/DATA_ROOT
          // from ENGINE_STATE_DIR when those per-root vars are unset — see vm/apps/engine/engine.ts.)
          ENGINE_STATE_DIR: '/app/data/state',
          DATASOURCE_DATA_DIR: '/app/data/datasources',
          DATASOURCES_DIR: '/app/data/datasources',
          // THE PLATFORM THIS BOX BELONGS TO. Without it the engine does not consider itself part of a fleet:
          // it fetches no credential from the vault, routes nothing through the proxy, and tunnels nothing —
          // so a freshly created machine would come up with none of that, and the failure reads as "claude is
          // not logged in" rather than "this variable is missing". Derived from the Worker's own host, so a
          // machine always points at the control plane that made it.
          SUPERATOM_PLATFORM: config.platform ?? config.workerWsHost,
          // claude-code auth: prefer the per-machine token if given, else inherit the Fly app secret
          // CLAUDE_CODE_OAUTH_TOKEN (set once via `fly secrets set` — available to every machine).
          ...(config.claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOAuthToken } : {}),
        },
        mounts: [
          { volume: vol.id, path: '/app/data' },
        ],
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly create machine failed (${res.status}): ${body}`)
  }

  const data = await res.json() as any
  console.log(`[fly] created machine ${data.id} (${machineName}) in ${appName}`)

  return { id: data.id, name: machineName, state: data.state || 'created', volumeId: vol.id }
}

// ── Start / stop / destroy ────────────────────────────────────────────────────

export async function startMachine(token: string, machineId: string, appName: string = FLY_APP): Promise<void> {
  const res = await flyRequest(token, `/apps/${appName}/machines/${machineId}/start`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly start machine failed (${res.status}): ${body}`)
  }
  console.log(`[fly] started machine ${machineId}`)
}

export async function stopMachine(token: string, machineId: string, appName: string = FLY_APP): Promise<void> {
  const res = await flyRequest(token, `/apps/${appName}/machines/${machineId}/stop`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly stop machine failed (${res.status}): ${body}`)
  }
  console.log(`[fly] stopped machine ${machineId}`)
}

export async function suspendMachine(token: string, machineId: string, appName: string = FLY_APP): Promise<void> {
  const res = await flyRequest(token, `/apps/${appName}/machines/${machineId}/suspend`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly suspend machine failed (${res.status}): ${body}`)
  }
  console.log(`[fly] suspended machine ${machineId}`)
}

export async function destroyMachine(token: string, machineId: string, appName: string = FLY_APP): Promise<void> {
  // Fetch machine first to get attached volume ID
  let volumeId: string | undefined
  try {
    const info = await getMachineStatus(token, machineId, appName)
    volumeId = (info as any).config?.mounts?.[0]?.volume
  } catch { /* proceed even if we can't read the machine */ }

  const res = await flyRequest(token, `/apps/${appName}/machines/${machineId}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly destroy machine failed (${res.status}): ${body}`)
  }
  console.log(`[fly] destroyed machine ${machineId}`)

  // Destroy the attached volume
  if (volumeId) {
    const volRes = await flyRequest(token, `/apps/${appName}/volumes/${volumeId}`, { method: 'DELETE' })
    if (volRes.ok) {
      console.log(`[fly] destroyed volume ${volumeId}`)
    } else {
      console.warn(`[fly] failed to destroy volume ${volumeId} (will need manual cleanup)`)
    }
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function getMachineStatus(token: string, machineId: string, appName: string = FLY_APP): Promise<MachineInfo> {
  const res = await flyRequest(token, `/apps/${appName}/machines/${machineId}`)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly get machine failed (${res.status}): ${body}`)
  }
  const data = await res.json() as any
  return { id: data.id, name: data.name, state: data.state }
}

// ── Wait for machine to be ready ──────────────────────────────────────────────

export async function waitForMachine(token: string, machineId: string, appName: string = FLY_APP, timeoutMs: number = 60000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { state } = await getMachineStatus(token, machineId, appName)
    if (state === 'started') return
    if (state === 'stopped' || state === 'suspended') {
      // Need to start it
      await startMachine(token, machineId, appName)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`Machine ${machineId} did not become ready within ${timeoutMs}ms`)
}
