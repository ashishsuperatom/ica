// ── The program catalogue — built programs the platform keeps ───────────────────────────────────────────────────────
//
// An engine builds a program (the one place that compiles) and uploads its bundle here. The platform checks the bundle
// against its hash with the same code the engine made it with, keeps it in R2 at programs/<project>/<hash>.json, and
// records it in the project's catalogue: a draft of whoever built it, until its owner (or an admin) publishes it.
// Engines fetch a program by hash. A hash is immutable: uploading the same one again changes nothing.

import { putObject, type Ledger } from './storage.js'
import { keyOf, checkSize } from './files.js'
import { verifyBundle, type ProgramBundle } from '../../../vm/packages/programs/src/bundle.js'

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }
export interface CatalogueEntry { hash: string; name: string; version: number; scope: string; owner: string; attaches_to: string | null; bytes: number; built_by: string; uploaded_at: string; published_at: string | null; published_by: string | null }

export class CatalogueRefusal extends Error {}

export class ProgramCatalogue {
  constructor(private sql: Sql, private bucket: R2Bucket, private project: () => string, private ledger: () => Ledger) {}
  private key = (hash: string) => keyOf.program(this.project(), hash)   // where a bundle lives: files.ts
  private row = (r: Record<string, unknown>): CatalogueEntry => ({ hash: String(r.hash), name: String(r.name), version: Number(r.version), scope: String(r.scope), owner: String(r.owner), attaches_to: (r.attaches_to as string) ?? null,
    bytes: Number(r.bytes), built_by: String(r.built_by), uploaded_at: String(r.uploaded_at), published_at: (r.published_at as string) ?? null, published_by: (r.published_by as string) ?? null })

  get(hash: string): CatalogueEntry | null { const [r] = [...this.sql.exec('SELECT * FROM programs WHERE hash = ?', hash)]; return r ? this.row(r) : null }
  list(q: { name?: string; published?: boolean } = {}): CatalogueEntry[] {
    return [...this.sql.exec('SELECT * FROM programs ORDER BY uploaded_at DESC LIMIT 500')].map(this.row)
      .filter((e) => (!q.name || e.name === q.name) && (q.published === undefined || (e.published_at !== null) === q.published))
  }

  /** Keep a bundle an engine built for `by`. Returns the entry, and whether it was new. */
  async upload(bundle: unknown, by: string): Promise<{ entry: CatalogueEntry; added: boolean }> {
    const bad = await verifyBundle(bundle)
    if (bad.length) throw new CatalogueRefusal(bad.join('; '))
    const b = bundle as ProgramBundle
    const have = this.get(b.hash)
    if (have) return { entry: have, added: false }
    let m: any
    try { m = JSON.parse(b.files['manifest.json']) } catch { throw new CatalogueRefusal('manifest.json is not JSON') }
    if (typeof m?.name !== 'string' || !Number.isInteger(m.version)) throw new CatalogueRefusal('the manifest names the program and its version')
    const text = JSON.stringify(b)
    try { checkSize('program', new TextEncoder().encode(text).byteLength) } catch (e: any) { throw new CatalogueRefusal(e.message) }
    await putObject(this.bucket, this.ledger(), { key: this.key(b.hash), kind: 'program', bytes: new TextEncoder().encode(text).byteLength, by, body: text, contentType: 'application/json', meta: { name: m.name, builtBy: by } })
    this.sql.exec('INSERT OR IGNORE INTO programs (hash, name, version, scope, owner, attaches_to, manifest, bytes, built_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.hash, m.name, m.version, String(m.scope ?? 'global'), by, m.attachesTo ?? null, b.files['manifest.json'], text.length, by, new Date().toISOString())
    return { entry: this.get(b.hash)!, added: true }
  }

  /** A program's bundle, checked again on the way out (R2 is trusted, but a bad object must never run). */
  async bundle(hash: string): Promise<ProgramBundle> {
    if (!this.get(hash)) throw new CatalogueRefusal(`there is no program ${hash.slice(0, 12)}`)
    const o = await this.bucket.get(this.key(hash))
    if (!o) throw new CatalogueRefusal(`program ${hash.slice(0, 12)} is in the catalogue but its bundle is missing`)
    const b = JSON.parse(await o.text())
    const bad = await verifyBundle(b)
    if (bad.length) throw new CatalogueRefusal(`program ${hash.slice(0, 12)}: ${bad.join('; ')}`)
    return b
  }

  /** Publish a program: its owner or an admin, once. */
  publish(hash: string, who: { id: string; admin: boolean }): CatalogueEntry {
    const e = this.get(hash)
    if (!e) throw new CatalogueRefusal(`there is no program ${hash.slice(0, 12)}`)
    if (e.published_at) throw new CatalogueRefusal(`program ${e.name} (${hash.slice(0, 12)}) was already published by ${e.published_by}`)
    if (!who.admin && e.owner !== who.id) throw new CatalogueRefusal(`program ${e.name} is ${e.owner}'s — its owner or an admin publishes it`)
    this.sql.exec('UPDATE programs SET published_at = ?, published_by = ? WHERE hash = ? AND published_at IS NULL', new Date().toISOString(), who.id, hash)
    return this.get(hash)!
  }
}
