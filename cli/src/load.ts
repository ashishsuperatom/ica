// sacli warehouse load — a file's tables into the organisation's warehouse (SA-WAREHOUSE): a DuckDB database (each of its
// tables), a CSV file (one table), an Excel workbook (each sheet a table). DuckDB reads all three, so a column's type is
// what DuckDB makes of it; each is mapped to one the warehouse keeps, and its rows are sent in batches as they are read
// (one pass over the data, never all of it in memory).
//
// Nothing is touched until every table is known to be loadable: a table the warehouse already has is refused unless the
// load says --replace (dropped and made again — its owner and the projects' grants stay with its name) or --append (its
// columns must be the file's).

import { basename, extname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { CliError } from './config.ts'

export interface LoadOpts { table?: string; sheet?: string; tables?: string[]; replace?: boolean; append?: boolean; project?: string; batchRows?: number; batchBytes?: number }
/** One call to the organisation's warehouse (sacli's organisation-key call). */
export type OrgCall = (body: Record<string, unknown>) => Promise<any>
export interface Loaded { table: string; from: string; rows: number; batches: number; seconds: number; columns: { name: string; type: string; was?: string; from: string }[]; granted?: string }

/** What the warehouse keeps a DuckDB type as, and the SQL that reads a value of it as that (a plain JS value). */
export function warehouseType(duck: string): { type: string; read: (c: string) => string } {
  const t = duck.toUpperCase()
  if (t === 'BOOLEAN') return { type: 'boolean', read: (c) => c }
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT)$/.test(t)) return { type: 'int', read: (c) => c }
  // 64-bit integers travel as text, so no digit is lost on the way.
  if (/^(BIGINT|UINTEGER)$/.test(t)) return { type: 'long', read: (c) => `CAST(${c} AS VARCHAR)` }
  if (/^(UBIGINT|HUGEINT|UHUGEINT)$/.test(t)) return { type: 'double', read: (c) => `CAST(${c} AS DOUBLE)` }
  if (t === 'FLOAT') return { type: 'float', read: (c) => c }
  if (t === 'DOUBLE' || t.startsWith('DECIMAL')) return { type: 'double', read: (c) => `CAST(${c} AS DOUBLE)` }
  if (t === 'DATE') return { type: 'date', read: (c) => `strftime(${c}, '%Y-%m-%d')` }
  if (t === 'TIMESTAMP WITH TIME ZONE' || t === 'TIMESTAMPTZ') return { type: 'timestamptz', read: (c) => `strftime(timezone('UTC', ${c}), '%Y-%m-%dT%H:%M:%S.%gZ')` }
  // A timestamp without a zone keeps its wall-clock time (written as if it were UTC, read back the same).
  if (t.startsWith('TIMESTAMP')) return { type: 'timestamp', read: (c) => `strftime(CAST(${c} AS TIMESTAMP), '%Y-%m-%dT%H:%M:%S.%gZ')` }
  if (t === 'BLOB') return { type: 'string', read: (c) => `base64(${c})` }
  if (/[\[\]]|^(STRUCT|MAP|UNION|LIST|JSON)/.test(t)) return { type: 'string', read: (c) => `CAST(to_json(${c}) AS VARCHAR)` }
  return { type: 'string', read: (c) => `CAST(${c} AS VARCHAR)` }
}

/** A name the warehouse takes: lower case, letters, digits and _, a letter (or _ for a column) first. */
export function warehouseName(raw: string, what: 'table' | 'column'): string {
  let n = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!n) n = what
  if (!/^[a-z]/.test(n)) n = (what === 'table' ? 't_' : '_') + n
  return n.slice(0, 63)
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The sheets of an .xlsx workbook, in order — read from the zip's xl/workbook.xml (DuckDB reads a sheet, it does not list them). */
export function xlsxSheets(file: string): string[] {
  const buf = readFileSync(file)
  // The zip's end record, then its central directory: find xl/workbook.xml and inflate it.
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new CliError(`${file} is not an .xlsx workbook (no zip directory)`, 2)
  let at = buf.readUInt32LE(end + 16)
  const count = buf.readUInt16LE(end + 10)
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    if (name === 'xl/workbook.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const raw = buf.subarray(start, start + size)
      const xml = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8')
      const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescape(m[1]!))
    }
    at += 46 + nameLen + extraLen + commentLen
  }
  throw new CliError(`${file} has no xl/workbook.xml — is it an .xlsx workbook?`, 2)
}

interface Source { table: string; from: string; relation: string }

/** Load a file's tables. `note` says what is happening (stderr); the result says what was loaded and how fast. */
export async function loadFile(path: string, o: LoadOpts, call: OrgCall, note: (s: string) => void): Promise<Loaded[]> {
  const file = resolve(path)
  if (!existsSync(file) || !statSync(file).isFile()) throw new CliError(`there is no file ${path}`, 2)
  if (o.replace && o.append) throw new CliError('--replace or --append, not both', 2)
  const ext = extname(file).toLowerCase()
  const stem = basename(file, extname(file))
  let duck: typeof import('@duckdb/node-api')
  try { duck = await import('@duckdb/node-api') } catch { throw new CliError('reading files needs DuckDB: pnpm add -g @duckdb/node-api (or install sacli with its dependencies)', 1) }
  const db = await duck.DuckDBInstance.create(':memory:')
  const conn = await db.connect()
  try {
    // ── What the file holds: each table, the relation that reads it ──
    let sources: Source[] = []
    if (ext === '.duckdb' || ext === '.db' || ext === '.ddb') {
      await conn.run(`ATTACH ${lit(file)} AS src (READ_ONLY)`)
      const listed = (await conn.runAndReadAll(`SELECT schema_name AS s, table_name AS t FROM duckdb_tables() WHERE database_name = 'src' ORDER BY 1, 2`)).getRowObjectsJson() as { s: string; t: string }[]
      const views = (await conn.runAndReadAll(`SELECT schema_name AS s, view_name AS t FROM duckdb_views() WHERE database_name = 'src' AND NOT internal ORDER BY 1, 2`)).getRowObjectsJson() as { s: string; t: string }[]
      const all = [...listed.map((x) => ({ ...x, view: false })), ...views.map((x) => ({ ...x, view: true }))]
      const named = (x: { s: string; t: string }) => (x.s === 'main' ? x.t : `${x.s}.${x.t}`)
      const picked = o.tables?.length ? all.filter((x) => o.tables!.includes(named(x)) || o.tables!.includes(x.t)) : all.filter((x) => !x.view)
      for (const w of o.tables ?? []) if (!all.some((x) => named(x) === w || x.t === w)) throw new CliError(`${basename(file)} has no table or view "${w}" (it has: ${all.map(named).join(', ')})`, 2)
      if (!o.tables?.length && views.length) note(`views not loaded (name them with --tables to load them): ${views.map(named).join(', ')}`)
      sources = picked.map((x) => ({ table: warehouseName(x.s === 'main' ? x.t : `${x.s}_${x.t}`, 'table'), from: named(x), relation: `src.${q(x.s)}.${q(x.t)}` }))
    } else if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      sources = [{ table: warehouseName(stem, 'table'), from: basename(file), relation: `read_csv(${lit(file)})` }]
    } else if (ext === '.xlsx') {
      await conn.run('INSTALL excel; LOAD excel;').catch((e: any) => { throw new CliError(`DuckDB's Excel reader could not be loaded (it is downloaded once): ${e?.message ?? e}`, 1) })
      const sheets = xlsxSheets(file)
      if (o.sheet && !sheets.includes(o.sheet)) throw new CliError(`${basename(file)} has no sheet "${o.sheet}" (it has: ${sheets.join(', ')})`, 2)
      const picked = o.sheet ? [o.sheet] : sheets
      sources = picked.map((s) => ({ table: warehouseName(picked.length === 1 ? (o.sheet ? s : stem) : s, 'table'), from: `${basename(file)} · ${s}`, relation: `read_xlsx(${lit(file)}, sheet = ${lit(s)}, header = true)` }))
    } else throw new CliError(`${ext || 'a file without an extension'} is not loaded: a DuckDB database (.duckdb), a CSV (.csv) or an Excel workbook (.xlsx)`, 2)
    if (o.table) { if (sources.length !== 1) throw new CliError(`--table names one table, and ${basename(file)} holds ${sources.length} — pick one with ${ext === '.xlsx' ? '--sheet' : '--tables'}`, 2); sources[0]!.table = warehouseName(o.table, 'table') }
    if (!sources.length) throw new CliError(`${basename(file)} has no tables to load`, 2)
    const twice = sources.find((s, i) => sources.findIndex((x) => x.table === s.table) !== i)
    if (twice) throw new CliError(`two tables of the file would both be named ${twice.table} in the warehouse — load them one at a time with --table`, 2)

    // ── Each table's columns, as the warehouse will keep them; and every conflict found before anything is done ──
    const have = new Map<string, any>(((await call({ t: 'warehouse:tables' })).tables ?? []).map((t: any) => [t.name, t]))
    const plans: { s: Source; columns: Loaded['columns']; select: string; rows: number }[] = []
    for (const s of sources) {
      let described: { column_name: string; column_type: string }[]
      try { described = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${s.relation}`)).getRowObjectsJson() as any }
      catch (e: any) { throw new CliError(`${s.from} could not be read: ${String(e?.message ?? e).split('\n')[0]}`, 1) }
      const used = new Set<string>()
      const columns = described.map((d) => {
        let n = warehouseName(d.column_name, 'column'); for (let i = 2; used.has(n); i++) n = `${warehouseName(d.column_name, 'column').slice(0, 60)}_${i}`; used.add(n)
        return { name: n, type: warehouseType(d.column_type).type, from: d.column_type, ...(n !== d.column_name ? { was: d.column_name } : {}) }
      })
      const select = `SELECT ${described.map((d, i) => `${warehouseType(d.column_type).read(q(d.column_name))} AS ${q(columns[i]!.name)}`).join(', ')} FROM ${s.relation}`
      const rows = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${s.relation}`)).getRowObjectsJson()[0]?.n ?? 0)
      const there = have.get(s.table)
      if (there && !o.replace && !o.append) throw new CliError(`the warehouse has a table ${s.table} already — --replace to load it again (drop and make it anew), or --append to add these rows`, 1)
      if (there && o.append) {
        const differs = columns.filter((c) => !there.columns.some((x: any) => x.name === c.name && x.type === c.type))
        if (differs.length) throw new CliError(`${s.table}'s columns are not the file's (${differs.map((c) => `${c.name} ${c.type}`).join(', ')}) — --replace to make it anew`, 1)
      }
      if (!there && o.append) throw new CliError(`there is no table ${s.table} to append to`, 1)
      plans.push({ s, columns, select, rows })
    }

    // ── Load: make (or drop and make) each table, then its rows in batches as they are read ──
    const out: Loaded[] = []
    const maxRows = Math.min(o.batchRows ?? 50_000, 50_000), maxBytes = o.batchBytes ?? 8 * 1024 * 1024
    for (const p of plans) {
      const t0 = Date.now()
      if (have.has(p.s.table) && o.replace) { await call({ t: 'warehouse:drop', table: p.s.table }); note(`${p.s.table}: dropped, to be made again`) }
      if (!o.append) await call({ t: 'warehouse:create', name: p.s.table, columns: p.columns.map(({ name, type }) => ({ name, type })), description: `Loaded from ${p.s.from}` })
      note(`${p.s.table}: ${p.rows.toLocaleString()} rows, ${p.columns.length} columns, from ${p.s.from}`)
      const names = p.columns.map((c) => c.name)
      const result = await conn.stream(p.select)
      let batch: Record<string, unknown>[] = [], bytes = 0, sent = 0, batches = 0
      const flush = async () => {
        if (!batch.length) return
        await call({ t: 'warehouse:append', table: p.s.table, rows: batch })
        sent += batch.length; batches++
        const s = (Date.now() - t0) / 1000
        note(`${p.s.table}: ${sent.toLocaleString()} of ${p.rows.toLocaleString()} rows (${Math.round(sent / Math.max(s, 0.001)).toLocaleString()} rows/s)`)
        batch = []; bytes = 0
      }
      for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
        for (const r of chunk.getRowObjects(names)) {
          batch.push(r as Record<string, unknown>)
          bytes += JSON.stringify(r).length
          if (batch.length >= maxRows || bytes >= maxBytes) await flush()
        }
      }
      await flush()
      let granted: string | undefined
      if (o.project) { const g = await call({ t: 'warehouse:grant', project: o.project, table: p.s.table, columns: null, write: false }); if (g?.error) throw new CliError(g.error); granted = o.project }
      out.push({ table: p.s.table, from: p.s.from, rows: sent, batches, seconds: (Date.now() - t0) / 1000, columns: p.columns, ...(granted ? { granted } : {}) })
    }
    return out
  } finally { conn.closeSync?.(); db.closeSync?.() }
}
