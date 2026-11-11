// WHAT THE SQL WAREHOUSES SHARE — written once for the connectors to Snowflake, BigQuery, Databricks and Redshift (each
// its own folder in bridges/). A warehouse is read with SQL like any database, but three of them answer over HTTPS
// rather than a driver: a statement is posted, perhaps runs on after the first answer (polled), and its rows come in
// parts. What every one of them needs, and nothing that is one system's own:
//
//   named           @name placeholders in a query → the system's own parameter style, in order of appearance
//   call            one HTTPS call, JSON in and out: retried on 429 and 5xx (Retry-After honoured), a refusal in words
//   reachable       does an address answer at all (a setup check before any credential is given)
//   signJwt         a JSON Web Token signed with RS256 (a service account's key, a key pair) — node:crypto only
//   plainNumber     a number written as text → a number, when a double holds it exactly
//   listOf, ident   a setting's comma-separated list; an identifier quoted only when it must be
//   signaturesOf    a signature per table from its catalog's columns (src/api.ts signatureOf)
//   keysSql, keysFrom  primary and foreign keys from the standard information_schema views

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { signatureOf } from './api'

/** A failure to show a person as it is: what the system said, with its HTTP status and its own code when it gave them. */
export class SourceError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message) }
}

/** The status codes worth trying again: too many requests, the system busy or restarting. */
export const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
/** An error worth trying again (the engine retries it): too many requests, busy, or the network in between. */
export function isTransientError(e: any): boolean {
  if (typeof e?.status === 'number') return RETRY_STATUS.has(e.status)
  return /\b(429|50[0234])\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|timed? ?out|other side closed/i.test(`${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? e}`)
}

/** @name → the system's own placeholder, for each name the params hold (any other @word is left as written — a stage, a
 *  variable). `mark(name, i)`: i counts distinct names in order of first appearance. Returns the text, the distinct names
 *  in that order, and every occurrence in order (for systems whose placeholders are positional, one value each). */
export function named(sql: string, params: Record<string, unknown> = {}, mark: (name: string, i: number) => string): { text: string; names: string[]; occurrences: string[] } {
  const names: string[] = [], occurrences: string[] = []
  const text = String(sql).replace(/(^|[^:@\w])@(\w+)/g, (m, pre: string, n: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, n)) return m
    let i = names.indexOf(n); if (i < 0) { names.push(n); i = names.length - 1 }
    occurrences.push(n)
    return `${pre}${mark(n, i)}`
  })
  return { text, names, occurrences }
}

/** A setting given as a list ("public, sales" or one per line) → its items. */
export const listOf = (v: unknown): string[] => String(v ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)

/** An identifier as SQL must be written: as it is when `bare` matches it, else in quotes (a quote inside doubled). */
export function ident(name: string, bare: RegExp, q: '"' | '`' = '"'): string {
  return bare.test(name) ? name : `${q}${name.split(q).join(q + q)}${q}`
}

/** A number written as text, as a number when a double holds it exactly (at most 15 significant digits); else the text,
 *  so a large id or a precise decimal is never rounded. */
export function plainNumber(v: unknown): unknown {
  if (typeof v !== 'string' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return v
  const digits = v.trim().replace(/[eE].*$/, '').replace(/[-+.]/g, '').replace(/^0+/, '').replace(/0+$/, '')
  return digits.length <= 15 ? Number(v) : v
}

/** Per table, a signature of its columns (`name:type`): it changes exactly when a column is added, renamed, retyped or
 *  dropped. Rows are one per column, as a catalog lists them. */
export function signaturesOf(rows: { table: string; column: string; type: string }[]): Record<string, string> {
  const cols = new Map<string, string[]>()
  for (const r of rows) (cols.get(r.table) ?? cols.set(r.table, []).get(r.table)!).push(`${r.column}:${r.type}`)
  return Object.fromEntries([...cols].map(([t, c]) => [t, signatureOf(c)]))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { sleep }

/** One HTTPS call, JSON in and out (a body that is a string is sent as it is: a form). Retried on 429 and 5xx at most
 *  `retries` times, backing off and honouring Retry-After. A refusal throws a SourceError saying what the system said
 *  (`said` reads its error body), with words a person can act on: the sign-in refused, not allowed, not found. */
export async function call<T = any>(fetchFn: typeof fetch, url: string, o: { system: string; method?: string; headers?: Record<string, string>; body?: unknown; retries?: number; timeoutMs?: number; said?: (data: any) => { message?: string; code?: string } | undefined }): Promise<{ status: number; data: T; headers: Headers }> {
  const retries = o.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    let r: Response
    try {
      r = await fetchFn(url, {
        method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
        headers: { accept: 'application/json', ...(o.body !== undefined && typeof o.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
        ...(o.body !== undefined ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
      })
    } catch (e: any) {
      // the network in between: said with its cause (a name that does not resolve, a refused or dropped connection)
      const cause = e?.cause?.code ?? e?.cause?.message ?? ''
      throw new SourceError(`${o.system} could not be reached at ${new URL(url).host}: ${e?.name === 'TimeoutError' ? 'it did not answer in time (timed out)' : `${e?.message ?? e}${cause ? ` (${cause})` : ''}`}`)
    }
    if (RETRY_STATUS.has(r.status) && attempt < retries) {
      const after = Number(r.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : 400 * 2 ** attempt)
      continue
    }
    const text = await r.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (r.status >= 400) {
      const s = (data && typeof data === 'object' ? o.said?.(data) : undefined) ?? {}
      const words = (s.message ?? (typeof data === 'string' ? data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '')).slice(0, 600)
      const said = words ? `: ${words}` : ''
      const message = r.status === 401 ? `${o.system} refused the sign-in (401 unauthorized)${said}`
        : r.status === 403 ? `${o.system} did not allow it (403 forbidden)${said}`
        : r.status === 404 ? `${o.system} found no such thing (404)${said}`
        : r.status === 429 ? `${o.system} is answering too many requests (429); try again shortly${said}`
        : `${o.system} answered ${r.status}${said}`
      throw new SourceError(message, r.status, s.code)
    }
    return { status: r.status, data: data as T, headers: r.headers }
  }
}

/** Does anything answer at this address over HTTPS (any status counts)? Said in words; throws when nothing does. */
export async function reachable(fetchFn: typeof fetch, url: string, system: string): Promise<string> {
  try {
    await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(15_000) })
    return `${new URL(url).host} answers`
  } catch (e: any) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? ''
    throw new SourceError(`${system} could not be reached at ${new URL(url).host}: ${e?.name === 'TimeoutError' ? 'it did not answer in time (timed out)' : `${e?.message ?? e}${cause ? ` (${cause})` : ''}`}`)
  }
}

/** A private key given as PEM — mended when pasted into a one-line box (its line breaks lost or written as \n). */
export function pemOf(raw: string): string {
  const s = String(raw ?? '').replace(/\\n/g, '\n').trim()
  const m = /^(-----BEGIN [A-Z ]+-----)\s*([\s\S]*?)\s*(-----END [A-Z ]+-----)$/.exec(s)
  if (!m) return s
  const body = m[2].replace(/\s+/g, '')
  return `${m[1]}\n${body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n${m[3]}\n`
}

/** A private key from PEM (encrypted ones with their passphrase), refused in words. */
export function privateKeyOf(pem: string, passphrase?: string): KeyObject {
  try { return createPrivateKey({ key: pemOf(pem), format: 'pem', ...(passphrase ? { passphrase } : {}) }) }
  catch (e: any) { throw new SourceError(`the private key could not be read — paste it whole, from -----BEGIN to -----END-----${/passphrase|decrypt|bad decrypt/i.test(e?.message ?? '') ? ', with its passphrase' : ''} (${e?.message ?? e})`) }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')
/** A JSON Web Token signed with RS256: its claims, signed with the key; `header` adds to { alg, typ } (a key id). */
export function signJwt(claims: Record<string, unknown>, key: KeyObject, header: Record<string, string> = {}): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...header }))
  const body = b64url(JSON.stringify(claims))
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`
}

/** The keys a catalog's standard views hold (information_schema: table_constraints, key_column_usage,
 *  referential_constraints): each primary-key column, and each foreign-key column with the column it points to — matched
 *  by position, so a key of several columns pairs them rightly. `at` is where the views are (`main.information_schema`). */
export const keysSql = (at: string) => `SELECT k.table_schema, k.table_name, k.column_name, tc.constraint_type, u.table_catalog AS ref_catalog, u.table_schema AS ref_schema, u.table_name AS ref_table, u.column_name AS ref_column
  FROM ${at}.table_constraints tc
  JOIN ${at}.key_column_usage k ON k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
  LEFT JOIN ${at}.referential_constraints r ON r.constraint_schema = tc.constraint_schema AND r.constraint_name = tc.constraint_name
  LEFT JOIN ${at}.key_column_usage u ON u.constraint_schema = r.unique_constraint_schema AND u.constraint_name = r.unique_constraint_name AND u.ordinal_position = k.position_in_unique_constraint
  WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`

/** keysSql's rows → which columns are keys and what each foreign key points to, by `table\ncolumn` (tables named by
 *  `nameOf`; a referenced table in another catalog than `catalog` keeps its catalog). */
export function keysFrom(rows: Record<string, any>[], nameOf: (schema: string, table: string) => string, catalog?: string): { primary: Set<string>; refs: Map<string, string> } {
  const primary = new Set<string>(), refs = new Map<string, string>()
  for (const r of rows) {
    const at = `${nameOf(r.table_schema, r.table_name)}\n${r.column_name}`
    if (r.constraint_type === 'PRIMARY KEY') primary.add(at)
    else if (r.ref_table && r.ref_column) refs.set(at, `${r.ref_catalog && catalog && r.ref_catalog !== catalog ? `${r.ref_catalog}.` : ''}${nameOf(r.ref_schema, r.ref_table)}.${r.ref_column}`)
  }
  return { primary, refs }
}
