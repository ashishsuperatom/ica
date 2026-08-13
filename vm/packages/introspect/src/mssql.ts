// ── MSSQL introspection ───────────────────────────────────────────────────────
// The common, dataset-agnostic moves the modeling agent re-derives every run, done once here in
// T-SQL. Each takes the data seam `query(sourceId, sql, params)` and the source id. Keep improving
// these — whatever proves essential across projects gets added.

import type { Introspect, QueryFn } from './index.js'

// [schema].[table] — default schema dbo; bracket-quote to be safe.
const qualify = (t: string) => { const p = t.split('.'); const tbl = p.pop()!; const sch = p.pop() ?? 'dbo'; return `[${sch}].[${tbl}]` }
const parts = (t: string) => { const p = t.split('.'); const tbl = p.pop()!; return { schema: p.pop() ?? 'dbo', table: tbl } }
const col = (c: string) => `[${c}]`

export function mssqlIntrospect(query: QueryFn, source: string): Introspect {
  return {
    // All tables + (fast, metadata) row counts.
    async tables() {
      return query(source, `
        SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS name, SUM(p.rows) AS rows
        FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        GROUP BY t.schema_id, t.name ORDER BY rows DESC`)
    },

    async columns(table) {
      const { schema, table: tbl } = parts(table)
      return query(source, `
        SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`, { s: schema, t: tbl })
    },

    // SEE real rows — the agent should look at actual data, not only aggregates.
    async sampleRows(table, n = 5) {
      return query(source, `SELECT TOP ${Math.max(1, Math.min(n, 100))} * FROM ${qualify(table)}`)
    },

    // Per-column stats: count/distinct/nulls/min/max/mean + the top values (mode = the first).
    async profile(table, column) {
      const T = qualify(table), C = col(column)
      const [m] = await query(source, `
        SELECT COUNT(*) AS total, COUNT(DISTINCT ${C}) AS distinctCount,
          SUM(CASE WHEN ${C} IS NULL THEN 1 ELSE 0 END) AS nulls,
          MIN(${C}) AS minv, MAX(${C}) AS maxv, AVG(TRY_CAST(${C} AS float)) AS mean
        FROM ${T}`)
      const top = await query(source, `SELECT TOP 5 ${C} AS v, COUNT(*) AS c FROM ${T} GROUP BY ${C} ORDER BY c DESC`)
      return {
        total: m.total, distinct: m.distinctCount, nulls: m.nulls,
        nullRate: m.total ? m.nulls / m.total : 0,
        min: m.minv, max: m.maxv, mean: m.mean,
        mode: top[0]?.v, topValues: top,
      }
    },

    // Join EVIDENCE: coverage + cardinality + the DATA that reveals problems (unmatched from-values,
    // from-side distribution). The agent judges; `hint` is a soft aside, not a verdict.
    async verifyJoin(fromTable, fromCol, toTable, toCol) {
      const F = qualify(fromTable), FC = col(fromCol), TO = qualify(toTable), TC = col(toCol)
      const [r] = await query(source, `
        SELECT
          (SELECT COUNT(*) FROM ${F}) AS fromTotal,
          (SELECT COUNT(*) FROM ${F} f WHERE f.${FC} IS NOT NULL AND EXISTS (SELECT 1 FROM ${TO} t WHERE t.${TC} = f.${FC})) AS matched,
          (SELECT COUNT(DISTINCT ${FC}) FROM ${F}) AS distinctFrom,
          (SELECT COUNT(DISTINCT ${TC}) FROM ${TO}) AS distinctTo,
          (SELECT COUNT(*) FROM ${TO}) AS toTotal`)
      // the from-values that DON'T match — this is where sentinels (0) and orphans show themselves.
      const unmatchedSamples = await query(source, `
        SELECT TOP 10 ${FC} AS v, COUNT(*) AS c FROM ${F} f
        WHERE f.${FC} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${TO} t WHERE t.${TC} = f.${FC})
        GROUP BY ${FC} ORDER BY c DESC`)
      const fromTopValues = await query(source, `SELECT TOP 5 ${FC} AS v, COUNT(*) AS c FROM ${F} GROUP BY ${FC} ORDER BY c DESC`)
      const coverage = r.fromTotal ? r.matched / r.fromTotal : 0
      const cardinality = `${r.distinctFrom === r.fromTotal ? '1' : 'N'}:${r.distinctTo === r.toTotal ? '1' : 'N'}`
      let hint: string | undefined
      if (r.distinctTo <= 5 && coverage > 0.9) hint = `low target cardinality (${r.distinctTo} distinct) — high coverage may be coincidental, not a real key; look at fromTopValues/unmatchedSamples`
      else if (unmatchedSamples.length && coverage < 0.99) hint = `${((1 - coverage) * 100).toFixed(1)}% unmatched — check unmatchedSamples for a sentinel (e.g. 0) before treating as broken`
      return { coverage, matched: r.matched, fromTotal: r.fromTotal, distinctFrom: r.distinctFrom, distinctTo: r.distinctTo, toTotal: r.toTotal, cardinality, unmatchedSamples, fromTopValues, hint }
    },

    // Conservation / arithmetic check: pass a SQL condition that SHOULD hold; get the violation
    // count + actual violating rows (not a yes/no). e.g. checkRelation('trp_trn_booking', 'Amount = PaidAmount + BalanceAmount').
    async checkRelation(table, expr, sampleN = 10) {
      const T = qualify(table)
      const [r] = await query(source, `SELECT COUNT(*) AS total, SUM(CASE WHEN (${expr}) THEN 0 ELSE 1 END) AS violations FROM ${T}`)
      const sampleViolations = await query(source, `SELECT TOP ${Math.max(1, Math.min(sampleN, 50))} * FROM ${T} WHERE NOT (${expr})`)
      return { total: r.total, violations: r.violations, violationRate: r.total ? r.violations / r.total : 0, sampleViolations }
    },
  }
}
