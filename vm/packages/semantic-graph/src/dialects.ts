// ── SQL DIALECTS: WHAT DIFFERS BY SOURCE, AND NOTHING ELSE ─────────────────────────────────────────────────────
//
// Dates and their periods, moments moved between zones, the median, a row of literals, a limit, the first value of an
// ordered subquery, and following a self arrow to everything above an element. Everything else the executor writes —
// joins on subqueries, CASE, IN, COUNT(DISTINCT), grouping — is SQL every source accepts.
//
// Keys of periods are the same text in every dialect and in calendar.ts, so an answer's groups do not depend on where
// its facts were read. Dates keep each source's own type: text in SQLite and landed files, DATE in Oracle and SQL
// Server; a date the question gives is written in that type.
//
//   sqlite   verified: every test runs on it
//   duckdb   verified against the duckdb CLI (test/dialects.duckdb.test.mts)
//   oracle   NetSuite's SuiteQL — written, checked by statement shape; not yet run against NetSuite
//   mssql    written, checked by statement shape; not yet run against SQL Server

import { addDays, builtIn, monthsIn, type CalendarDef } from './calendar.js'
import type { Stretch } from './time.js'

export interface Dialect {
  name: string
  quote(identifier: string): string
  /** A date the question gives, bound as a parameter, in the source's date type. */
  date(param: string): string
  /** The key of the period a date is in: 2026-09-14, 2026-09, 2026-Q3, 2026, FY2027-Q1, a listed label. */
  key(calendar: CalendarDef, date: string): string
  /** The last day of the period starting at a date, in the source's date type. */
  periodEnd(calendar: CalendarDef, start: string): string
  /** The day a moment falls on once moved by the minutes in force for its stretch, in the source's date type. */
  localDay(moment: string, stretches: Stretch[]): string
  /** A median of a group: SQL that computes it, or collects the values for it to be computed after. */
  median(value: string): { sql: string; collected: boolean }
  /** A statement of one row of literal values. */
  row(select: string): string
  /** A statement keeping only its first `n` rows. */
  limit(sql: string, n: number): string
  /** One value from a subquery ordered so the first row is wanted. */
  first(select: string, from: string, where: string, orderBy: string): string
  /** Whether an element, or anything above it along a self arrow, is in a list — null where it cannot be written. */
  under(element: string, entitySql: string, key: string, parent: string, list: string): string | null
}

const text = (s: string) => `'${s.replace(/'/g, "''")}'`
type Period = NonNullable<CalendarDef['periods']>[number]

/** Everything above each element, as (element, ancestor) pairs, the element included — uncorrelated, so it runs once. */
const closure = (q: (id: string) => string, entitySql: string, key: string, parent: string, all: boolean) =>
  `WITH RECURSIVE up(k, anc) AS (SELECT u.${q(key)}, u.${q(key)} FROM (${entitySql}) u UNION ${all ? 'ALL ' : ''}SELECT up.k, u.${q(parent)} FROM up JOIN (${entitySql}) u ON u.${q(key)} = up.anc WHERE u.${q(parent)} IS NOT NULL) SELECT k FROM up`

export const sqlite: Dialect = {
  name: 'sqlite',
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  date: (p) => p,
  key: (c, d) => {
    if (c.periods) return listedCase(c, d, text, (p) => text(p.label))
    if (c.fiscal) {
      const { period, startMonth } = c.fiscal
      const fy = `strftime('%Y', date(${d}, 'start of month', '+${(13 - startMonth) % 12} months'))`
      const into = `((CAST(strftime('%m', ${d}) AS INTEGER) - ${startMonth} + 12) % 12)`
      return period === 'year' ? `('FY' || ${fy})` : period === 'quarter' ? `('FY' || ${fy} || '-Q' || (${into} / 3 + 1))` : `('FY' || ${fy} || '-P' || printf('%02d', ${into} + 1))`
    }
    const level = builtIn(c)
    return level === 'day' ? `date(${d})` : level === 'week' ? `date(${d}, '-' || ((CAST(strftime('%w', ${d}) AS INTEGER) + 6) % 7) || ' days')`
      : level === 'month' ? `strftime('%Y-%m', ${d})` : level === 'quarter' ? `(strftime('%Y', ${d}) || '-Q' || ((CAST(strftime('%m', ${d}) AS INTEGER) + 2) / 3))` : `strftime('%Y', ${d})`
  },
  periodEnd: (c, d) => {
    if (c.periods) return listedCase(c, d, text, (p) => text(addDays(p.to, -1)))
    const level = builtIn(c)
    if (level === 'day') return `date(${d})`
    if (level === 'week') return `date(${d}, '+6 days')`
    return `date(${d}, '+${monthsIn(c)} months', '-1 day')`
  },
  localDay: (m, st) => `date(datetime(${m}, ${stretchCase(m, st, text, (n) => text(`${n >= 0 ? '+' : ''}${n} minutes`))}))`,
  median: (v) => ({ sql: `json_group_array(${v})`, collected: true }),
  row: (select) => `SELECT ${select}`,
  limit: (sql, n) => `${sql}\nLIMIT ${Math.floor(n)}`,
  first: (select, from, where, orderBy) => `(SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${orderBy} LIMIT 1)`,
  under: (e, sql, key, parent, list) => `${e} IN (SELECT c.k FROM (${closure(sqlite.quote, sql, key, parent, false).replace(/SELECT k FROM up$/, `SELECT k FROM up WHERE anc IN (${list})`)}) c)`,
}

/** DuckDB, with dates as ISO text — as files landed from other systems keep them — or DATE. */
export const duckdb: Dialect = {
  name: 'duckdb',
  quote: sqlite.quote,
  date: (p) => p,
  key: (c, d) => {
    const day = `CAST(${d} AS DATE)`
    if (c.periods) return listedCase(c, `strftime(${day}, '%Y-%m-%d')`, text, (p) => text(p.label))
    if (c.fiscal) {
      const { period, startMonth } = c.fiscal
      const fy = `CAST(year(${day} + to_months(${(13 - startMonth) % 12})) AS VARCHAR)`
      const into = `((month(${day}) - ${startMonth} + 12) % 12)`
      return period === 'year' ? `('FY' || ${fy})` : period === 'quarter' ? `('FY' || ${fy} || '-Q' || CAST(${into} // 3 + 1 AS VARCHAR))` : `('FY' || ${fy} || '-P' || lpad(CAST(${into} + 1 AS VARCHAR), 2, '0'))`
    }
    const level = builtIn(c)
    return level === 'day' ? `strftime(${day}, '%Y-%m-%d')` : level === 'week' ? `strftime(date_trunc('week', ${day}), '%Y-%m-%d')`
      : level === 'month' ? `strftime(${day}, '%Y-%m')` : level === 'quarter' ? `(strftime(${day}, '%Y') || '-Q' || CAST(quarter(${day}) AS VARCHAR))` : `strftime(${day}, '%Y')`
  },
  periodEnd: (c, d) => {
    const day = `CAST(${d} AS DATE)`
    if (c.periods) return listedCase(c, `strftime(${day}, '%Y-%m-%d')`, text, (p) => text(addDays(p.to, -1)))
    const level = builtIn(c)
    const end = level === 'day' ? day : level === 'week' ? `${day} + INTERVAL 6 DAY` : `${day} + to_months(${monthsIn(c)}) - INTERVAL 1 DAY`
    return `strftime(${end}, '%Y-%m-%d')`
  },
  localDay: (m, st) => `strftime(CAST(${m} AS TIMESTAMP) + to_minutes(CAST(${stretchCase(`strftime(CAST(${m} AS TIMESTAMP), '%Y-%m-%d %H:%M:%S')`, st, text, String)} AS BIGINT)), '%Y-%m-%d')`,
  median: (v) => ({ sql: `median(${v})`, collected: false }),
  row: (select) => `SELECT ${select}`,
  limit: sqlite.limit,
  first: sqlite.first,
  under: (e, sql, key, parent, list) => `${e} IN (SELECT c.k FROM (${closure(sqlite.quote, sql, key, parent, false).replace(/SELECT k FROM up$/, `SELECT k FROM up WHERE anc IN (${list})`)}) c)`,
}

/** Oracle, and NetSuite's SuiteQL: dates are DATE; there is no row without FROM dual. */
export const oracle: Dialect = {
  name: 'oracle',
  quote: sqlite.quote,
  date: (p) => `TO_DATE(${p}, 'YYYY-MM-DD')`,
  key: (c, d) => {
    if (c.periods) return listedCase(c, d, (x) => `TO_DATE(${text(x)}, 'YYYY-MM-DD')`, (p) => text(p.label))
    if (c.fiscal) {
      const { period, startMonth } = c.fiscal
      const fy = `TO_CHAR(ADD_MONTHS(TRUNC(${d}, 'MM'), ${(13 - startMonth) % 12}), 'YYYY')`
      const into = `MOD(EXTRACT(MONTH FROM ${d}) - ${startMonth} + 12, 12)`
      return period === 'year' ? `('FY' || ${fy})` : period === 'quarter' ? `('FY' || ${fy} || '-Q' || TO_CHAR(TRUNC(${into} / 3) + 1))` : `('FY' || ${fy} || '-P' || LPAD(TO_CHAR(${into} + 1), 2, '0'))`
    }
    const level = builtIn(c)
    return level === 'day' ? `TO_CHAR(${d}, 'YYYY-MM-DD')` : level === 'week' ? `TO_CHAR(TRUNC(${d}, 'IW'), 'YYYY-MM-DD')`
      : level === 'month' ? `TO_CHAR(${d}, 'YYYY-MM')` : level === 'quarter' ? `(TO_CHAR(${d}, 'YYYY') || '-Q' || TO_CHAR(${d}, 'Q'))` : `TO_CHAR(${d}, 'YYYY')`
  },
  periodEnd: (c, d) => {
    if (c.periods) return listedCase(c, d, (x) => `TO_DATE(${text(x)}, 'YYYY-MM-DD')`, (p) => `TO_DATE(${text(addDays(p.to, -1))}, 'YYYY-MM-DD')`)
    const level = builtIn(c)
    return level === 'day' ? `TRUNC(${d})` : level === 'week' ? `(TRUNC(${d}) + 6)` : `(ADD_MONTHS(TRUNC(${d}), ${monthsIn(c)}) - 1)`
  },
  localDay: (m, st) => `TRUNC(${m} + ${stretchCase(m, st, (x) => `TO_DATE(${text(x)}, 'YYYY-MM-DD HH24:MI:SS')`, String)} / 1440)`,
  median: (v) => ({ sql: `MEDIAN(${v})`, collected: false }),
  row: (select) => `SELECT ${select} FROM dual`,
  limit: (sql, n) => `${sql}\nFETCH FIRST ${Math.floor(n)} ROWS ONLY`,
  first: (select, from, where, orderBy) => `(SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${orderBy} FETCH FIRST 1 ROWS ONLY)`,
  under: (e, sql, key, parent, list) => `${e} IN (SELECT c.k FROM (${closure(sqlite.quote, sql, key, parent, true).replace('WITH RECURSIVE up', 'WITH up').replace(/SELECT k FROM up$/, `SELECT k FROM up WHERE anc IN (${list})`)}) c)`,
}

/** SQL Server: dates are date; the first rows by TOP; a recursive query cannot sit inside another, so "under" is not written. */
export const mssql: Dialect = {
  name: 'mssql',
  quote: (id) => `[${id.replace(/]/g, ']]')}]`,
  date: (p) => `CAST(${p} AS date)`,
  key: (c, d) => {
    if (c.periods) return listedCase(c, d, (x) => `CAST(${text(x)} AS date)`, (p) => text(p.label))
    if (c.fiscal) {
      const { period, startMonth } = c.fiscal
      const fy = `CAST(DATEPART(year, DATEADD(month, ${(13 - startMonth) % 12}, ${d})) AS varchar(4))`
      const into = `((DATEPART(month, ${d}) - ${startMonth} + 12) % 12)`
      return period === 'year' ? `('FY' + ${fy})` : period === 'quarter' ? `('FY' + ${fy} + '-Q' + CAST(${into} / 3 + 1 AS varchar(1)))` : `('FY' + ${fy} + '-P' + RIGHT('0' + CAST(${into} + 1 AS varchar(2)), 2))`
    }
    const level = builtIn(c)
    return level === 'day' ? `CONVERT(char(10), ${d}, 23)` : level === 'week' ? `CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, '19000101', ${d}) % 7), CAST(${d} AS date)), 23)`
      : level === 'month' ? `CONVERT(char(7), ${d}, 23)` : level === 'quarter' ? `CONCAT(DATEPART(year, ${d}), '-Q', DATEPART(quarter, ${d}))` : `CAST(DATEPART(year, ${d}) AS varchar(4))`
  },
  periodEnd: (c, d) => {
    if (c.periods) return listedCase(c, d, (x) => `CAST(${text(x)} AS date)`, (p) => `CAST(${text(addDays(p.to, -1))} AS date)`)
    const level = builtIn(c)
    return level === 'day' ? `CAST(${d} AS date)` : level === 'week' ? `DATEADD(day, 6, CAST(${d} AS date))` : `DATEADD(day, -1, DATEADD(month, ${monthsIn(c)}, CAST(${d} AS date)))`
  },
  localDay: (m, st) => `CAST(DATEADD(minute, ${stretchCase(m, st, (x) => `CAST(${text(x)} AS datetime2)`, String)}, ${m}) AS date)`,
  median: (v) => ({ sql: `('[' + STRING_AGG(CAST(${v} AS varchar(40)), ',') + ']')`, collected: true }),
  row: (select) => `SELECT ${select}`,
  limit: (sql, n) => sql.replace(/^SELECT /, `SELECT TOP ${Math.floor(n)} `),
  first: (select, from, where, orderBy) => `(SELECT TOP 1 ${select} FROM ${from} WHERE ${where} ORDER BY ${orderBy})`,
  under: () => null,
}

export const DIALECTS: Record<string, Dialect> = { sqlite, duckdb, oracle, mssql }

function listedCase(c: CalendarDef, d: string, date: (x: string) => string, value: (p: Period) => string) {
  return `(CASE ${c.periods!.map((p) => `WHEN ${d} >= ${date(p.from)} AND ${d} < ${date(p.to)} THEN ${value(p)}`).join(' ')} END)`
}
function stretchCase(m: string, st: Stretch[], moment: (x: string) => string, minutes: (n: number) => string) {
  return st.length === 1 ? minutes(st[0].minutes) : `(CASE ${st.slice(0, -1).map((x) => `WHEN ${m} < ${moment(x.until!)} THEN ${minutes(x.minutes)}`).join(' ')} ELSE ${minutes(st.at(-1)!.minutes)} END)`
}
