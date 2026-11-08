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
  // `for=question`: given with the next question (its in/ folder), not kept as a file of the whole session.
  const forQuestion = url.searchParams.get('for') === 'question'
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
  await o.home.fetch(new Request('http://door/attach/tell', { method: 'POST', headers: { 'x-sa-claims': claims }, body: JSON.stringify({ project: o.project, wsId: admitted.wsId, session: o.session, name, type, hash, size: bytes.length, ...(forQuestion ? { question: true } : {}) }) }))
  return json({ ok: true, session: o.session, name, hash, size: bytes.length, type }, 201)
}

// ── A session's file, read by its person (GET /api/sessions/<project>/<session>/attachments/<hash>?name=) ──────────────
// Through their door: admitted to the project and the session is theirs (their UserDO decides). Then the bytes, straight
// from the bucket, as a download under the name asked for — never shown in the page's own origin.
export async function readAttachment(env: Env, o: { project: string; session: string; hash: string; name: string; claims: Claims; home: Home }): Promise<Response> {
  const admitted: any = await o.home.fetch(new Request('http://door/attach/read', { method: 'POST', headers: { 'x-sa-claims': JSON.stringify(o.claims) }, body: JSON.stringify({ project: o.project, session: o.session }) })).then((r) => r.json()).catch(() => null)
  if (!admitted?.ok) return Response.json({ error: admitted?.reason ?? 'no access to this file' }, { status: 403 })
  const bucket = (env as any).PACKAGES as R2Bucket | undefined
  if (!bucket) return Response.json({ error: 'no bucket bound' }, { status: 503 })
  const obj = await bucket.get(keyOf.attachment(o.project, o.session, o.hash))
  if (!obj) return Response.json({ error: 'no such file' }, { status: 404 })
  const name = /^[\w][\w .()-]{0,119}$/.test(o.name) && !o.name.includes('..') ? o.name : o.hash.slice(0, 12)
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-length': String(obj.size), 'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } })
}

// ── A file the engine gives a person with an answer (PUT /api/engine/<project>/files/<session>/<hash>?name=&type=) ─────
// With the project's key; kept beside the person's own files of that session, by its hash (the bytes must hash to it).
export async function putEngineFile(env: Env, request: Request, o: { project: string; session: string; hash: string; isEngine: () => Promise<boolean> }): Promise<Response> {
  if (!(await o.isEngine())) return Response.json({ error: "only the project's engine gives files" }, { status: 401 })
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (!Number.isFinite(declared)) return Response.json({ error: 'a file says how big it is (Content-Length)' }, { status: 411 })
  if (declared > LIMITS.attachment) return Response.json({ error: `a file is at most ${LIMITS.attachment / 1024 / 1024} MB` }, { status: 413 })
  const bytes = new Uint8Array(await request.arrayBuffer())
  try { checkSize('attachment', bytes.length) } catch (e: any) { return Response.json({ error: e.message }, { status: e.status ?? 400 }) }
  if (await sha256Hex(bytes) !== o.hash) return Response.json({ error: 'the bytes do not hash to the name given' }, { status: 400 })
  const bucket = (env as any).PACKAGES as R2Bucket | undefined
  if (!bucket) return Response.json({ error: 'no bucket bound' }, { status: 503 })
  const type = (new URL(request.url).searchParams.get('type') ?? 'application/octet-stream').slice(0, 100)
  const ledger = remoteLedger((env as any).PROJECT.get((env as any).PROJECT.idFromName(`proj:${o.project}`)), o.project)
  try { await putObject(bucket, ledger, { key: keyOf.attachment(o.project, o.session, o.hash), kind: 'attachment', bytes: bytes.length, by: 'engine', body: bytes, contentType: type, once: true }) }
  catch (e: any) { return Response.json({ error: e.message }, { status: e.status ?? 400 }) }
  return Response.json({ ok: true, hash: o.hash, size: bytes.length }, { status: 201 })
}
