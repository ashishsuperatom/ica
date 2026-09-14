// ── SQL DIALECTS: THE FEW THINGS THAT DIFFER BY SOURCE ───────────────────────────────────────────────────────────
//
// Dates, period labels, limits, text, the median — and conditions, which are the same everywhere but bind their
// values through the statement's parameters. Everything else the engine writes is SQL every source accepts.

import type { BuiltInGrain } from './calendar.js'
import type { Condition, Scalar } from './coordinates.js'
import { CoordinateError } from './errors.js'

export type Dialect = 'oracle' | 'mssql' | 'sqlite'
const refuse = (msg: string): never => { throw new CoordinateError(msg) }


export interface SqlDialect {
  date(param: string): string
  /** The label of the period a date falls in. Labels are the same strings in every dialect and in `periods`. */
  period(grain: BuiltInGrain, column: string): string
  /** A date written into the statement, for a calendar's period boundaries. */
  dateLiteral(date: string): string
  limit(sql: string, n: number): string
  /** An expression as text. */
  text(expr: string): string
  /** The median, where the dialect has one. */
  median?: (expr: string) => string
}

export function sqlFor(dialect: Dialect): SqlDialect {
  if (dialect === 'mssql') return {
    date: (p) => `CAST(@${p} AS date)`,
    dateLiteral: (d) => `CAST('${d}' AS date)`,
    period: (g, c) => ({
      day: `CONVERT(char(10), ${c}, 23)`,
      // 1900-01-01 was a Monday, so days since then modulo 7 is days since Monday — independent of DATEFIRST.
      week: `CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, '19000101', ${c}) % 7), CAST(${c} AS date)), 23)`,
      month: `CONVERT(char(7), ${c}, 23)`,
      quarter: `CONCAT(DATEPART(year, ${c}), '-Q', DATEPART(quarter, ${c}))`,
      year: `CAST(DATEPART(year, ${c}) AS varchar(4))`,
    })[g],
    limit: (sql, n) => sql.replace(/^SELECT /, `SELECT TOP ${n} `),
    text: (e) => `CAST(${e} AS nvarchar(4000))`,
  }
  if (dialect === 'sqlite') return {
    date: (p) => `@${p}`,
    dateLiteral: (d) => `'${d}'`,
    period: (g, c) => ({
      day: `date(${c})`,
      week: `date(${c}, '-' || ((CAST(strftime('%w', ${c}) AS INTEGER) + 6) % 7) || ' days')`,
      month: `strftime('%Y-%m', ${c})`,
      quarter: `strftime('%Y', ${c}) || '-Q' || ((CAST(strftime('%m', ${c}) AS INTEGER) + 2) / 3)`,
      year: `strftime('%Y', ${c})`,
    })[g],
    limit: (sql, n) => `${sql}\nLIMIT ${n}`,
    text: (e) => `CAST(${e} AS TEXT)`,
  }
  return {
    date: (p) => `TO_DATE(@${p}, 'YYYY-MM-DD')`,
    dateLiteral: (d) => `TO_DATE('${d}', 'YYYY-MM-DD')`,
    period: (g, c) => ({
      day: `TO_CHAR(${c}, 'YYYY-MM-DD')`,
      week: `TO_CHAR(TRUNC(${c}, 'IW'), 'YYYY-MM-DD')`,
      month: `TO_CHAR(${c}, 'YYYY-MM')`,
      quarter: `TO_CHAR(${c}, 'YYYY') || '-Q' || TO_CHAR(${c}, 'Q')`,
      year: `TO_CHAR(${c}, 'YYYY')`,
    })[g],
    limit: (sql, n) => `${sql}\nFETCH FIRST ${n} ROWS ONLY`,
    median: (e) => `MEDIAN(${e})`,
    text: (e) => `TO_CHAR(${e})`,
  }
}

/** A condition as SQL, binding each value through `bind`, which returns the placeholder to write. */
export function conditionSql(expr: string, cond: Condition, what: string, bind: (v: unknown) => string): string[] {
  if (cond === null) return [`${expr} IS NULL`]
  if (Array.isArray(cond)) return [cond.length ? `${expr} IN (${cond.map(bind).join(', ')})` : '1 = 0']
  if (typeof cond !== 'object') return [`${expr} = ${bind(cond)}`]
  const out: string[] = []
  for (const [op, v] of Object.entries(cond)) {
    if (op === 'isNull') out.push(v ? `${expr} IS NULL` : `${expr} IS NOT NULL`)
    else if (op === 'in' || op === 'notIn') {
      const list = v as Scalar[]
      out.push(list.length ? `${expr} ${op === 'in' ? 'IN' : 'NOT IN'} (${list.map(bind).join(', ')})` : op === 'in' ? '1 = 0' : '1 = 1')
    } else {
      const sqlOp = ({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op]
      if (!sqlOp) refuse(`unknown condition "${op}" on ${what} — use in, notIn, eq, ne, gt, gte, lt, lte or isNull`)
      out.push(`${expr} ${sqlOp} ${bind(v)}`)
    }
  }
  return out
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────

