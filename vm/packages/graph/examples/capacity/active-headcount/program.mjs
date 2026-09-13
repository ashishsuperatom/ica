export default async function (ctx, { pillarId }) {
  const where = pillarId ? `AND e.department = @pillarId` : ''
  const [row] = await ctx.query('F5NETSUITE',
    `SELECT COUNT(*) AS n FROM employee e WHERE e.isinactive = 'F' ${where}`, { pillarId })
  return { headcount: Number(row.n) }
}
