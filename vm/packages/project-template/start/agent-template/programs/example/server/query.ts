// The rule, once, as a query the source runs: the total and the number of keys worked out by the source over every row
// (window functions run before the limit), at most 100 rows returned.
export function exampleQuery(filter: string | null): { sql: string; params: Record<string, unknown> } {
  return {
    sql: `SELECT key, SUM(amount) AS value, SUM(SUM(amount)) OVER () AS total, COUNT(*) OVER () AS keys
          FROM some_table${filter ? ' WHERE key = @filter' : ''}
          GROUP BY key ORDER BY value DESC LIMIT 100`,
    params: filter ? { filter } : {},
  }
}
