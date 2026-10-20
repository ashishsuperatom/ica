// ── A file a person adds to one of their sessions (POST /api/sessions/<project>/<session>/attachments) ───────────────
//
// The decision goes through the person's door; the bytes never do (docs/one-door-plan.md: no big content through a
// Durable Object). Their UserDO admits them to the project first — refused, nothing is kept. Then the Worker keeps the
// bytes on the platform by their hash, through the one storage door (recorded in the project's ledger as this person's),
// and the UserDO tells the engine where the file is (session:attach) over the person's own link — the engine checks the
// session is theirs.

import { LIMITS, keyOf, checkSize, sha256Hex } from './files.js'
import { putObject, remoteLedger } from './storage.js'

type Claims = { userId: string; email?: string; role?: string }
type Home = { fetch(input: Request | string, init?: RequestInit): Promise<Response> }

export async function addAttachment(env: Env, request: Request, o: { project: string; session: string; claims: Claims; home: Home }): Promise<Response> {
  const url = new URL(request.url)
  const json = (v: unknown, status = 200) => Response.json(v, { status })
  const name = (url.searchParams.get('name') ?? '').trim(), type = (url.searchParams.get('type') ?? request.headers.get('content-type') ?? 'application/octet-stream').slice(0, 100)
  if (!/^[\w][\w .()-]{0,119}$/.test(name) || name.includes('..')) return json({ error: 'a file is named plainly (letters, digits, spaces, . _ - ( ), at most 120)' }, 400)
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (!Number.isFinite(declared)) return json({ error: 'a file says how big it is (Content-Length)' }, 411)   // never read without knowing
  if (declared > LIMITS.attachment) return json({ error: `a file is at most ${LIMITS.attachment / 1024 / 1024} MB` }, 413)   // refused before it is read
  const claims = JSON.stringify(o.claims)
  // 1. The person's door: may they add to this project? (Refused: nothing is kept.)
  const admitted: any = await o.home.fetch(new Request('http://door/attach/admit', { method: 'POST', headers: { 'x-sa-claims': claims }, body: JSON.stringify({ project: o.project }) })).then((r) => r.json()).catch(() => null)
  if (!admitted?.ok) return json({ error: admitted?.reason ?? 'no access to this project' }, 403)
  // 2. The bytes, straight to the bucket by their hash.
  const bytes = new Uint8Array(await request.arrayBuffer())
  try { checkSize('attachment', bytes.length) } catch (e: any) { return json({ error: e.message }, e.status ?? 400) }
  const bucket = (env as any).PACKAGES as R2Bucket | undefined
  if (!bucket) return json({ error: 'no bucket bound' }, 503)
  const hash = await sha256Hex(bytes)
  const ledger = remoteLedger((env as any).PROJECT.get((env as any).PROJECT.idFromName(`proj:${o.project}`)), o.project)
  try { await putObject(bucket, ledger, { key: keyOf.attachment(o.project, o.session, hash), kind: 'attachment', bytes: bytes.length, by: o.claims.email ?? `user:${o.claims.userId}`, body: bytes, contentType: type, once: true }) }
  catch (e: any) { return json({ error: e.message }, e.status ?? 400) }
  // 3. The engine told where it is, over the person's own link.
  await o.home.fetch(new Request('http://door/attach/tell', { method: 'POST', headers: { 'x-sa-claims': claims }, body: JSON.stringify({ project: o.project, wsId: admitted.wsId, session: o.session, name, type, hash, size: bytes.length }) }))
  return json({ ok: true, session: o.session, name, hash, size: bytes.length, type }, 201)
}
