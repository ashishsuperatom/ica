// ── SuiteQL (NetSuite) introspection ──────────────────────────────────────────
// NetSuite's SuiteQL is Oracle-flavoured. Same dialect-agnostic moves as the other modules, in SuiteQL.
// KEY: on this engine a blind `SELECT * ... FETCH FIRST n` on a multi-million-row table (e.g. timebill) can
// TIME OUT — the planner won't push the row-limit stopkey. `WHERE ROWNUM <= n` DOES stop early, so every
// bounded probe here uses ROWNUM. Aggregates (COUNT/…) are cheap; unbounded scans are the thing to avoid.

import type { Introspect, QueryFn } from './index.js'

const q = (t: string) => t.replace(/[^A-Za-z0-9_.]/g, '')   // SuiteQL identifiers are plain; strip anything odd
const lim = (n: number, cap = 100) => Math.max(1, Math.min(n, cap))

export function suiteqlIntrospect(query: QueryFn, source: string): Introspect {
  return {
    // oa_tables is SuiteQL's own catalog. Row counts aren't cheaply available here, so leave rows undefined.
    async tables() {
      const rows = await query(source, `SELECT table_name FROM oa_tables`)
      return rows.map((r: any) => ({ name: r.table_name ?? r.tablename ?? r.name })).filter((t: any) => t.name)
    },

    // No cheap column catalog in SuiteQL — read the keys off ONE row (ROWNUM stopkey → fast even on big tables).
    async columns(table) {
      const [row] = await query(source, `SELECT * FROM ${q(table)} WHERE ROWNUM <= 1`)
      return Object.keys(row ?? {}).filter((k) => k !== 'links').map((name) => ({ name, type: typeof (row as any)[name] }))
    },

    // SEE real rows — bounded with ROWNUM so it never scans a huge table. For a *filtered* sample the agent
    // should write its own query with a WHERE on an indexed column.
    async sampleRows(table, n = 5) {
      const rows = await query(source, `SELECT * FROM ${q(table)} WHERE ROWNUM <= ${lim(n)}`)
      return rows.map((r: any) => { delete r.links; return r })
    },

    async profile(table, column) {
      const T = q(table), C = q(column)
      const [m] = await query(source, `
        SELECT COUNT(*) AS total, COUNT(DISTINCT ${C}) AS distinctCount,
          SUM(CASE WHEN ${C} IS NULL THEN 1 ELSE 0 END) AS nulls,
          MIN(${C}) AS minv, MAX(${C}) AS maxv, AVG(${C}) AS mean
        FROM ${T}`)
      const top = await query(source, `SELECT ${C} AS v, COUNT(*) AS c FROM ${T} GROUP BY ${C} ORDER BY c DESC FETCH FIRST 5 ROWS ONLY`)
      return {
        total: m.total, distinct: m.distinctCount, nulls: m.nulls,
        nullRate: m.total ? m.nulls / m.total : 0,
        min: m.minv, max: m.maxv, mean: m.mean, mode: top[0]?.v, topValues: top,
      }
    },

    async verifyJoin(fromTable, fromCol, toTable, toCol) {
      const F = q(fromTable), FC = q(fromCol), TO = q(toTable), TC = q(toCol)
      const [r] = await query(source, `
        SELECT
          (SELECT COUNT(*) FROM ${F}) AS fromTotal,
          (SELECT COUNT(*) FROM ${F} f WHERE f.${FC} IS NOT NULL AND EXISTS (SELECT 1 FROM ${TO} t WHERE t.${TC} = f.${FC})) AS matched,
          (SELECT COUNT(DISTINCT ${FC}) FROM ${F}) AS distinctFrom,
          (SELECT COUNT(DISTINCT ${TC}) FROM ${TO}) AS distinctTo,
          (SELECT COUNT(*) FROM ${TO}) AS toTotal FROM dual`)
      const unmatchedSamples = await query(source, `
        SELECT ${FC} AS v, COUNT(*) AS c FROM ${F} f
        WHERE f.${FC} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${TO} t WHERE t.${TC} = f.${FC})
        GROUP BY ${FC} ORDER BY c DESC FETCH FIRST 10 ROWS ONLY`)
      const fromTopValues = await query(source, `SELECT ${FC} AS v, COUNT(*) AS c FROM ${F} GROUP BY ${FC} ORDER BY c DESC FETCH FIRST 5 ROWS ONLY`)
      const coverage = r.fromTotal ? r.matched / r.fromTotal : 0
      const cardinality = `${r.distinctFrom === r.fromTotal ? '1' : 'N'}:${r.distinctTo === r.toTotal ? '1' : 'N'}`
      let hint: string | undefined
      if (r.distinctTo <= 5 && coverage > 0.9) hint = `low target cardinality (${r.distinctTo} distinct) — high coverage may be coincidental; look at fromTopValues/unmatchedSamples`
      else if (unmatchedSamples.length && coverage < 0.99) hint = `${((1 - coverage) * 100).toFixed(1)}% unmatched — check unmatchedSamples for a sentinel before treating as broken`
      return { coverage, matched: r.matched, fromTotal: r.fromTotal, distinctFrom: r.distinctFrom, distinctTo: r.distinctTo, toTotal: r.toTotal, cardinality, unmatchedSamples, fromTopValues, hint }
    },

    async checkRelation(table, expr, sampleN = 10) {
      const T = q(table)
      const [r] = await query(source, `SELECT COUNT(*) AS total, SUM(CASE WHEN (${expr}) THEN 0 ELSE 1 END) AS violations FROM ${T}`)
      const sampleViolations = await query(source, `SELECT * FROM ${T} WHERE NOT (${expr}) FETCH FIRST ${lim(sampleN, 50)} ROWS ONLY`)
      return { total: r.total, violations: r.violations, violationRate: r.total ? r.violations / r.total : 0, sampleViolations }
    },
  }
}
