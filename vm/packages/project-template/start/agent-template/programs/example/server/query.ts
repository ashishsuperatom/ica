// The rule, once, as a query the source runs: totals in the source, at most 100 rows shown.
export function exampleQuery(filter: string | null): { sql: string; params: Record<string, unknown> } {
  return {
    sql: `SELECT key, SUM(amount) AS value FROM some_table${filter ? ' WHERE key = @filter' : ''} GROUP BY key ORDER BY value DESC`,
    params: filter ? { filter } : {},
  }
}
