// ── SUPERATOM'S CONNECTOR REGISTRY: the release door (docs/connectors-plan.md 9a/9b) ───────────────────────────────────
//
// Superatom's connectors are released apart from the platform: the release job (GitHub, on a push to dev) builds each
// connector with the one build tool, runs only that connector's checks, and sends it here with the release token — a
// secret only the job holds (there is no platform admin key: keys follow the people tree, downward only). Its code is
// kept in the bucket by its hash (connector/superatom/<id>/<hash>), its version recorded in the GlobalDO; every project
// reads its catalogue from there (ProjectDO superatomCatalogue). The same version sent again changes nothing.

import { checkEngineManifest } from '../../../connectors/src/contract.js'
import { putObject, type Ledger } from './storage.js'
import { connectorObjectKey } from './org-connectors.js'

/** Where Superatom's connectors are kept: their owner in the bucket's connector/<owner>/<id>/<hash>. */
export const SUPERATOM = 'superatom'
/** The platform's own objects are no project's storage: recorded nowhere (the registry itself lists them). */
const platformLedger: Ledger = { add: async () => {}, forget: async () => {} }
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('')

export async function releaseConnector(env: Env, request: Request): Promise<Response> {
  const json = (v: unknown, status = 200) => Response.json(v, { status })
  const token = String((env as any).CONNECTOR_RELEASE_TOKEN ?? '')
  const given = (request.headers.get('authorization') || '').replace(/^bearer\s+/i, '')
  if (!token) return json({ error: 'the platform has no release token set (CONNECTOR_RELEASE_TOKEN)' }, 503)
  if (!given || await sha(given) !== await sha(token)) return json({ error: 'only the release job releases Superatom\'s connectors' }, 401)
  const b: any = await request.json().catch(() => ({}))
  const manifest = b.manifest, code = typeof b.code === 'string' ? b.code : ''
  const bad = checkEngineManifest(manifest)
  if (bad.length) return json({ error: `its manifest: ${bad.join('; ')}` }, 400)
  if (manifest.builtin) return json({ error: "the platform's own source is not released as a connector" }, 400)
  if (!code.trim() || code.length > 6_000_000) return json({ error: 'its code is the built module, at most 6 MB' }, 400)
  if (!/export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge|export\s*\{[^}]*\bcreateBridge\b[^}]*\}/.test(code)) return json({ error: 'a connector exports createBridge({ settings, secrets })' }, 400)
  const hash = await sha(code)
  if (b.hash && b.hash !== hash) return json({ error: 'the code does not hash to the version named' }, 400)
  const bucket = (env as any).PACKAGES as R2Bucket | undefined
  if (!bucket) return json({ error: 'no bucket bound' }, 503)
  const bytes = new TextEncoder().encode(code).byteLength
  await putObject(bucket, platformLedger, { key: connectorObjectKey(SUPERATOM, manifest.id, hash), kind: 'connector', bytes, by: 'release', body: code, contentType: 'text/javascript', once: true })
  const r: any = await (env as any).GLOBAL.get((env as any).GLOBAL.idFromName('global')).fetch('http://do/superatom-connectors/release', { method: 'POST', body: JSON.stringify({ manifest, hash, bytes, notes: b.notes ?? null, commit: b.commit ?? null, by: 'release' }) }).then((x: Response) => x.json())
  if (!r?.ok) return json({ error: r?.error ?? 'the registry did not take it' }, 400)
  return json({ id: manifest.id, version: hash, bytes, ...(r.already ? { already: true } : {}) }, r.already ? 200 : 201)
}
