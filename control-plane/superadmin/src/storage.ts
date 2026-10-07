// ── Every object a project keeps in the bucket, written and removed through here — and recorded ──────────────────────
//
// The bucket is shared by every organisation, project and person, so each object is recorded in its project's ledger
// (the project's Durable Object, table stored_objects): its key, kind, size, who put it, when. From the ledger: how much
// a project stores, by kind and by person (an organisation's is the sum of its projects'), and the list of what a person
// or a project keeps — where it is, how big, what it is — to show, and to delete when asked. Writing or removing an object
// any other way would leave the ledger wrong, so nothing else touches the bucket.
//
// A key names its project in its second segment (<kind prefix>/<project>/…); kinds: parcel, program, bridge, app,
// attachment, dashboard. Secrets never come here: they are sealed in the project's Durable Object (proxy/seal.ts).

/** What a project keeps, by the key prefix each kind lives under. */
export const KINDS = { parcel: 'parcel', program: 'programs', bridge: 'bridge', app: 'app', attachment: 'attachments', dashboard: 'dashboard' } as const
export type ObjectKind = keyof typeof KINDS

export interface LedgerRow { key: string; kind: ObjectKind; bytes: number; by: string | null }
/** Where objects are recorded: the project's own ledger (in its Durable Object), or reached over its internal route. */
export interface Ledger { add(rows: LedgerRow[]): Promise<void>; forget(keys: string[]): Promise<void> }

/** The project a key belongs to, or null. */
export const projectOfKey = (key: string): string | null => /^[a-z]+\/([0-9a-f-]{36}|[^/]+)\//.exec(key)?.[1] ?? null
/** The kind a key is, by its prefix, or null. */
export const kindOfKey = (key: string): ObjectKind | null => (Object.entries(KINDS).find(([, p]) => key.startsWith(`${p}/`))?.[0] as ObjectKind) ?? null
/** Every prefix one project's objects live under. */
export const prefixesOf = (project: string): string[] => Object.values(KINDS).map((p) => `${p}/${project}/`)

/** Put one object and record it. `once`: a content-addressed object already there is not written again (nor counted
 *  twice: the ledger keeps one row per key). */
export async function putObject(bucket: R2Bucket, ledger: Ledger, o: LedgerRow & { body: ArrayBuffer | Uint8Array | string; contentType?: string; meta?: Record<string, string>; once?: boolean }): Promise<{ created: boolean }> {
  if (kindOfKey(o.key) !== o.kind) throw new Error(`${o.key} is not where a ${o.kind} lives`)
  if (o.once && await bucket.head(o.key)) { await ledger.add([{ key: o.key, kind: o.kind, bytes: o.bytes, by: o.by }]); return { created: false } }
  await bucket.put(o.key, o.body, { httpMetadata: { contentType: o.contentType ?? 'application/octet-stream' }, ...(o.meta ? { customMetadata: o.meta } : {}) })
  await ledger.add([{ key: o.key, kind: o.kind, bytes: o.bytes, by: o.by }])
  return { created: true }
}

/** Remove objects and forget them. */
export async function removeObjects(bucket: R2Bucket, ledger: Ledger, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
  if (keys.length) await ledger.forget(keys)
  return keys.length
}

/** Remove every object under some prefixes (a dashboard's builds, a session's files, a whole project) and forget them. */
export async function removeUnder(bucket: R2Bucket, ledger: Ledger, prefixes: string[]): Promise<number> {
  let gone = 0
  for (const prefix of prefixes) {
    let cursor: string | undefined
    do {
      const page = await bucket.list({ prefix, cursor })
      if (page.objects.length) gone += await removeObjects(bucket, ledger, page.objects.map((o) => o.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  return gone
}

/** A project's ledger, from outside its Durable Object (the worker, a person's hub): its internal routes. */
export function remoteLedger(stub: { fetch: (r: Request) => Promise<Response> }, project: string): Ledger {
  const call = async (path: string, body: unknown) => {
    const r = await stub.fetch(new Request(`http://do/storage/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-project': project }, body: JSON.stringify(body) }))
    if (!r.ok) throw new Error(`the project's ledger did not take it (${r.status})`)
  }
  return { add: (rows) => call('add', { rows }), forget: (keys) => call('forget', { keys }) }
}
