export default async function (ctx, { pillarId }) {
  const where = pillarId ? `AND e.department = @pillarId` : ''
  // NOT EVERY EMPLOYEE RECORD IS A PERSON. System accounts and placeholders — a timesheet integration, an
  // "undefined sales rep" — are active employee records with no first name. Counting them overstates headcount.
  const [row] = await ctx.query('F5NETSUITE',
    `SELECT COUNT(*) AS n, SUM(CASE WHEN e.firstname IS NULL THEN 1 ELSE 0 END) AS placeholders
     FROM employee e WHERE e.isinactive = 'F' ${where}`, { pillarId })
  const placeholders = Number(row.placeholders ?? 0)
  if (placeholders) ctx.caveat(`${placeholders} active record(s) with no first name are system accounts or placeholders, not people, and are excluded`)
  return { headcount: Number(row.n) - placeholders }
}
