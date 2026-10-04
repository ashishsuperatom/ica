// The rule, once: completed, not settled trips of a branch.
export function unsettledSql(branch: string | null): { sql: string; params: Record<string, unknown> } {
  return { sql: `SELECT trip_no, balance FROM trips WHERE completed = 1 AND settled = 0${branch ? ' AND branch = @branch' : ''}`, params: branch ? { branch } : {} }
}
