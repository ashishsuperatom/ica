// PER-TYPE INDEXERS ("templates"). Each type knows how to (a) LIST its containers (tables/collections) and
// (b) INDEX one container into flat DataSourceEntry rows. Split this way so the runner can be RESUMABLE:
// Phase 0 = listContainers (enumerate the work list); Phase N = indexContainer per item, persisting as it goes
// (resume = work-list − already-indexed). Generic per TYPE — zero source-specific coupling; a source passes
// extra seed tables via config, never hard-coded names.
//
// `source` is the datasource name — BOTH the query id and the SOURCE segment of every index key. Container/
// field names are preserved EXACTLY as the source spells them.
import { dsiKey, type DataSourceEntry } from '@superatom/datasource-index'

// ── The indexing / enrichment pipeline ──────────────────────────────────────────────────────────────────────
// IMPLEMENTED now (this file + the runner) — Steps 1–3. The system is fully usable on these alone:
//   1. ENUMERATE  list every container (source catalog → type fallbacks). Paged/bounded, never an unbounded pull.
//   2. INDEX      per container: its fields + the COMMON metadata (name, type; mssql also nullable/PK/FK).
//   3. COUNT      definitive row counts (mssql metadata only — never COUNT NetSuite, it scans) → auto-disable EMPTY
//                 containers so they don't pollute find-schema. A timeout is "unknown", never "empty".
//
// FUTURE — LAZY, incremental enrichment. NOT built. The connector agent runs these in the BACKGROUND, long after
// 1–3, one source (or column) at a time; each just ADDS intelligence, and the more that's combined the more the
// system can reason across sources. Deliberately kept separate from 1–3:
//   4. PROFILE    per-column statistics — min/max/mean, distinct & null rates, top values, and CARDINALITY
//                 (low-cardinality ⇒ categorical/enum ⇒ a drill-down dimension). Plus SEMANTIC-TYPE detection
//                 (email / phone / currency / date-in-string / id-vs-free-text) and PII / sensitivity flags
//                 (→ feed the authorization layer). Keep costly full-scan counts OFF NetSuite.
//   5. LINK       cross- AND intra-source relationships by VALUE OVERLAP — the actual values intersect (name/
//                 pattern similarity is at most a weak hint, not this). Infer FKs WITHIN a source (e.g.
//                 some sources declare none) and join keys ACROSS sources; CONFORMED ENTITIES (the same
//                 business thing in two systems); FRESHNESS / AUTHORITY (which source is more complete/recent
//                 for a shared entity).
//   6. DESCRIBE   AI writes table/column descriptions (→ the desc_ai field). LAST on purpose: it is richest once
//                 the profile (4) and links (5) exist — it can say "customer id · 99% populated · joins to
//                 F5NETSUITE.customer.id" instead of guessing from a name. (5 before 6 — linking needs no prose;
//                 descriptions improve once links exist.)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RawQuery = (source: string, sql: string) => Promise<any[]>
// catalogTables = the definitive table list from the source's own catalog (for NetSuite, the metadata-catalog via
// the bridge's /introspect) — the PRIMARY enumeration when available; the type-specific fallbacks fill in if not.
export interface IndexerOpts { seedTables?: string[]; catalogTables?: string[] }
export interface TypeIndexer {
  listContainers(source: string, query: RawQuery, opts: IndexerOpts): Promise<string[]>
  indexContainer(source: string, container: string, query: RawQuery): Promise<DataSourceEntry[]>
  // DEFINITIVE row counts (0 = truly empty → auto-disabled). Only return counts you actually got; omit anything
  // that timed out/errored (unknown, possibly huge) so it stays enabled. Optional — omit if the type can't count cheaply.
  rowCounts?(source: string, query: RawQuery): Promise<Record<string, number>>
}

const trim = (s: any) => String(s ?? '').trim()
export function inferType(v: any): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return 'datetime'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return 'date'
  return 'string'
}

// ── mssql (T-SQL) — full catalog. Columns/PKs/FKs fetched once per RUN and cached across indexContainer calls. ──
// CRITICAL: the raw/system path is NOT capped by the manager, so a large schema (10k–100k+ column rows) in one
// query can overflow the bridge's WebSocket ("Max decompressed message size exceeded"). Every metadata read is
// therefore PAGED in bounded chunks (OFFSET/FETCH) — never an unbounded pull, no matter how many tables.
const PAGE_ROWS = 5000
const MAX_META_ROWS = 2_000_000                                   // absolute backstop against a runaway loop
async function pagedRaw(source: string, query: RawQuery, selectSql: string, orderBy: string): Promise<any[]> {
  const all: any[] = []
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const page = await query(source, `${selectSql} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${PAGE_ROWS} ROWS ONLY`)
    if (!Array.isArray(page) || !page.length) break
    all.push(...page)
    if (page.length < PAGE_ROWS || all.length >= MAX_META_ROWS) break
  }
  return all
}
let _mssqlCache: { source: string; cols: Map<string, any[]>; pks: Set<string>; fks: Map<string, string> } | null = null
async function mssqlLoad(source: string, query: RawQuery) {
  if (_mssqlCache?.source === source) return _mssqlCache
  const cols = new Map<string, any[]>()
  for (const r of await pagedRaw(source, query, `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS`, `TABLE_NAME, COLUMN_NAME`)) {
    const t = trim(r.TABLE_NAME); (cols.get(t) ?? cols.set(t, []).get(t)!).push(r)
  }
  const pks = new Set<string>()
  try { for (const r of await pagedRaw(source, query, `SELECT ku.TABLE_NAME t, ku.COLUMN_NAME c FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY'`, `ku.TABLE_NAME, ku.COLUMN_NAME`)) pks.add(trim(r.t) + '.' + trim(r.c)) } catch {}
  const fks = new Map<string, string>()
  try { for (const r of await pagedRaw(source, query, `SELECT fk.TABLE_NAME ft, fk.COLUMN_NAME fc, pk.TABLE_NAME tt, pk.COLUMN_NAME tc FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk ON rc.CONSTRAINT_NAME=fk.CONSTRAINT_NAME JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk ON rc.UNIQUE_CONSTRAINT_NAME=pk.CONSTRAINT_NAME AND fk.ORDINAL_POSITION=pk.ORDINAL_POSITION`, `fk.TABLE_NAME, fk.COLUMN_NAME`)) fks.set(trim(r.ft) + '.' + trim(r.fc), trim(r.tt) + '.' + trim(r.tc)) } catch {}
  return (_mssqlCache = { source, cols, pks, fks })
}
const mssql: TypeIndexer = {
  // listContainers may throw if the source is unreachable (the essential COLUMNS query fails) — the runner
  // catches that per-source and moves to the next source. PK/FK enrichment is optional (guarded in mssqlLoad).
  async listContainers(source, query) { return [...(await mssqlLoad(source, query)).cols.keys()] },
  // Per-table: guarded so one weird table can't stop the run. (Columns come from the cached bulk load, so this
  // rarely fails, but a malformed row must not throw.)
  async indexContainer(source, container, query) {
    try {
      const c = await mssqlLoad(source, query)
      return (c.cols.get(container) ?? []).map((r) => {
        const field = trim(r.COLUMN_NAME), ck = container + '.' + field
        return { key: dsiKey(source, container, field), source, container, field, type: trim(r.DATA_TYPE),
          isOptional: trim(r.IS_NULLABLE).toUpperCase() === 'YES', isKey: c.pks.has(ck), references: c.fks.get(ck) }
      })
    } catch { return [] }
  },
  // Fast, DEFINITIVE base-table counts from metadata (sys.partitions) — no table scan, no timeout risk. Views
  // are omitted (no cheap definitive count) so they stay enabled (unknown, never wrongly disabled).
  async rowCounts(source, query) {
    const out: Record<string, number> = {}
    try { for (const r of await query(source, `SELECT t.name tbl, SUM(p.rows) n FROM sys.tables t JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN (0,1) GROUP BY t.name`)) out[trim(r.tbl)] = Number(r.n) || 0 } catch {}
    return out
  },
}

// ── suiteql (NetSuite/REST) — NO ODBC catalog. Enumerate: custom records LIVE via customrecordtype + a known
// STANDARD table list (general NetSuite knowledge, probed) + any config seeds. Index by sampling rows. ──
// STANDARD is the reusable per-type list — expanded from validating a real NetSuite schema (adds billing/charge/
// budget/resource-allocation/subsidiary-relationship/tax/etc. that a naive core list misses). Non-existent ones
// are simply skipped at index time, so over-including is harmless.
const NETSUITE_STANDARD = ['entity','customer','vendor','employee','contact','partner','job','projecttask','jobstatus','jobtype',
  'item','inventoryitem','assemblyitem','kititem','serviceitem','servicesaleitem','noninventoryitem','noninventorysaleitem',
  'noninventorypurchaseitem','otherchargeitem','otherchargesaleitem','discountitem','paymentitem','subtotalitem','descriptionitem',
  'giftcertificateitem','shipitem','unitstype','transaction','transactionline','transactionaccountingline','transactionhistory',
  'transactionstatus','invoice','salesorder','purchaseorder','vendorbill','vendorpayment','vendorcredit','creditmemo','cashsale',
  'cashrefund','customerpayment','customerrefund','customerdeposit','deposit','depositapplication','paymentadjustment','journalentry',
  'intercompanyjournalentry','advintercompanyjournalentry','statisticaljournalentry','check','creditcardcharge','creditcardrefund',
  'expensereport','expensecategory','itemfulfillment','itemreceipt','inventoryadjustment','inventorytransfer','opportunity','estimate',
  'returnauthorization','charge','chargerule','account','taxacct','accountingperiod','accountingbook','accountingtransaction','subsidiary',
  'department','location','classification','currency','currencyrate','budgets','budgetcategory','budgetimport','budgetlegacy','budgetsmachine',
  'billingclass','billingaccount','billingschedule','billingratecard','billingratecardversion','pricelevel','term','paymentmethod','salesrep',
  'revrecschedule','revrecplan','revrectemplate','revrecfieldmapping','taxschedule','timebill','timesheet','resourceallocation','resourceallocationtype',
  'customercategory','vendorcategory','customermessage','entitygroup','deletedrecord','calendarevent','timelineapprovalstatus',
  'customersubsidiaryrelationship','vendorsubsidiaryrelationship','employeesubsidiaryrelationship','projectsubsidiaryrelationship',
  'systemnote','note','notetype','file','folder','role','customrecordtype']

const suiteql: TypeIndexer = {
  // Enumeration is DEFENSE-IN-DEPTH: each source of names is independent + guarded, and we UNION whatever
  // succeeds. If customrecordtype is momentarily unavailable (token blip / timeout / rate limit) we still return
  // the standard + seed list; a later resume re-adds the custom records. Never throws — worst case returns [].
  async listContainers(source, query, opts) {
    const set = new Set<string>()
    // PRIMARY: the metadata-catalog (definitive standard + custom), passed in from the bridge's /introspect.
    for (const t of (opts.catalogTables ?? [])) { const s = String(t).toLowerCase(); if (s) set.add(s) }
    for (const t of (opts.seedTables ?? [])) set.add(t)            // config seeds
    for (const t of NETSUITE_STANDARD) set.add(t)                  // FALLBACK: general NetSuite knowledge (no-catalog case)
    try {                                                          // FALLBACK: custom records live (if the catalog was unavailable)
      const rows = await query(source, `SELECT scriptid FROM customrecordtype`)
      if (Array.isArray(rows)) for (const r of rows) { const s = r?.scriptid; if (s) set.add(String(s).toLowerCase()) }
    } catch (e: any) { console.warn(`  [${source}] customrecordtype enumeration failed (${String(e?.message ?? e).slice(0, 80)}) — using catalog/standard/seeds; resume will retry`) }
    return [...set].sort()
  },
  // One container = one sample call. EVERY failure mode (table absent, no permission, 429 rate-limit, timeout,
  // malformed response, empty table) → return [] so the runner moves to the next; the container just isn't in the
  // index, so a resume retries it. Never throws.
  async indexContainer(source, container, query) {
    let rows: any[]
    try { rows = await query(source, `SELECT * FROM ${container} WHERE ROWNUM <= 25`) }
    catch { return [] }                                            // absent / permission / rate-limit / timeout → skip
    if (!Array.isArray(rows) || !rows.length) return []            // empty table → can't infer columns; skip
    const cols = new Map<string, string | undefined>()
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue                    // guard a malformed row
      for (const [k, v] of Object.entries(r)) {
        if (!cols.has(k)) cols.set(k, inferType(v))
        else if (cols.get(k) == null && v != null) cols.set(k, inferType(v))
      }
    }
    return [...cols].map(([field, type]) => ({ key: dsiKey(source, container, field), source, container, field, type }))
  },
}

export const INDEXERS: Record<string, TypeIndexer> = { mssql, suiteql }
export function getIndexer(dialect: string): TypeIndexer {
  const t = INDEXERS[dialect]
  if (!t) throw new Error(`no indexer for dialect "${dialect}" (have: ${Object.keys(INDEXERS).join(', ')})`)
  return t
}
