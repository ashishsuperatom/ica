// PER-TYPE INDEXERS ("templates"). Each type knows how to (a) LIST its containers (tables/collections) and
// (b) INDEX one container into flat DataSourceEntry rows. Split this way so the runner can be RESUMABLE:
// Phase 0 = listContainers (enumerate the work list); Phase N = indexContainer per item, persisting as it goes
// (resume = work-list − already-indexed). Generic per TYPE — zero source-specific coupling; a source passes
// extra seed tables via config, never hard-coded names.
//
// `source` is the datasource name — BOTH the query id and the SOURCE segment of every index key. Container/
// field names are preserved EXACTLY as the source spells them.
import { dsiKey, type DataSourceEntry } from '@superatom/node-store'

export type RawQuery = (source: string, sql: string) => Promise<any[]>
export interface IndexerOpts { seedTables?: string[] }
export interface TypeIndexer {
  listContainers(source: string, query: RawQuery, opts: IndexerOpts): Promise<string[]>
  indexContainer(source: string, container: string, query: RawQuery): Promise<DataSourceEntry[]>
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
let _mssqlCache: { source: string; cols: Map<string, any[]>; pks: Set<string>; fks: Map<string, string> } | null = null
async function mssqlLoad(source: string, query: RawQuery) {
  if (_mssqlCache?.source === source) return _mssqlCache
  const cols = new Map<string, any[]>()
  for (const r of await query(source, `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS`)) {
    const t = trim(r.TABLE_NAME); (cols.get(t) ?? cols.set(t, []).get(t)!).push(r)
  }
  const pks = new Set<string>()
  try { for (const r of await query(source, `SELECT ku.TABLE_NAME t, ku.COLUMN_NAME c FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY'`)) pks.add(trim(r.t) + '.' + trim(r.c)) } catch {}
  const fks = new Map<string, string>()
  try { for (const r of await query(source, `SELECT fk.TABLE_NAME ft, fk.COLUMN_NAME fc, pk.TABLE_NAME tt, pk.COLUMN_NAME tc FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk ON rc.CONSTRAINT_NAME=fk.CONSTRAINT_NAME JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk ON rc.UNIQUE_CONSTRAINT_NAME=pk.CONSTRAINT_NAME AND fk.ORDINAL_POSITION=pk.ORDINAL_POSITION`)) fks.set(trim(r.ft) + '.' + trim(r.fc), trim(r.tt) + '.' + trim(r.tc)) } catch {}
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
    for (const t of (opts.seedTables ?? [])) set.add(t)            // config seeds
    for (const t of NETSUITE_STANDARD) set.add(t)                  // general NetSuite knowledge (probed at index time)
    try {                                                          // custom records, LIVE — the part that can blip
      const rows = await query(source, `SELECT scriptid FROM customrecordtype`)
      if (Array.isArray(rows)) for (const r of rows) { const s = r?.scriptid; if (s) set.add(String(s).toLowerCase()) }
    } catch (e: any) { console.warn(`  [${source}] customrecordtype enumeration failed (${String(e?.message ?? e).slice(0, 80)}) — using standard+seeds; resume will retry`) }
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
