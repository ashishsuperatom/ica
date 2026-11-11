// The rules, once, as queries the source runs. Totals and counts are worked out by the source over every row in scope
// (window functions run before the limit), never by adding up the rows shown; at most 100 rows come back.

/** What the view narrows by: the group a person chose (a filter), the key a click opened (a drill). */
export type Scope = { group: string | null; key: string | null }

const where = (s: Partial<Scope>) => {
  const parts = [s.group ? 'grp = @group' : '', s.key ? 'key = @key' : ''].filter(Boolean)
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params: { ...(s.group ? { group: s.group } : {}), ...(s.key ? { key: s.key } : {}) } }
}

/** Every key in scope, largest first: its amount, with the total and the number of keys in scope. */
export function keysQuery(s: Scope): { sql: string; params: Record<string, unknown> } {
  const w = where(s)
  return {
    sql: `SELECT key, SUM(amount) AS value, SUM(SUM(amount)) OVER () AS total, COUNT(*) OVER () AS keys
          FROM some_table${w.sql}
          GROUP BY key ORDER BY value DESC LIMIT 100`,
    params: w.params,
  }
}

/** The groups a person can choose, in the scope the other narrowings leave (never the group itself): each with how many
 *  keys it holds and their amount — only groups that hold something, so no choice gives an empty view. */
export function groupChoicesQuery(s: Scope): { sql: string; params: Record<string, unknown> } {
  const w = where({ key: s.key })
  return {
    sql: `SELECT grp AS value, COUNT(DISTINCT key) AS count, SUM(amount) AS amount
          FROM some_table${w.sql}
          GROUP BY grp HAVING COUNT(*) > 0 ORDER BY amount DESC LIMIT 100`,
    params: w.params,
  }
}
