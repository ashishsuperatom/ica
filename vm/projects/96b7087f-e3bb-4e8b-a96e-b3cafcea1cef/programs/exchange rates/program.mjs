// NetSuite's currencyrate holds one rate per pair per day: basecurrency is what the rate converts to, and
// transactioncurrency × exchangerate = basecurrency. The latest day on or before @asAt applies to every pair. That day
// is found first, on its own: NetSuite evaluates a latest-day subquery inside a join slowly.
export default async (ctx, { asAt }) => {
  const [latest] = await ctx.query('F5NETSUITE', `
    SELECT TO_CHAR(MAX(effectivedate), 'YYYY-MM-DD') AS day FROM currencyrate WHERE effectivedate <= TO_DATE(@asAt, 'YYYY-MM-DD')`, { asAt })
  return {
    source: 'F5NETSUITE',
    sql: `
      SELECT tc.symbol AS from_code, bc.symbol AS to_code, TO_NUMBER(r.exchangerate) AS rate
        FROM currencyrate r
        JOIN currency tc ON tc.id = r.transactioncurrency
        JOIN currency bc ON bc.id = r.basecurrency
       WHERE r.effectivedate = TO_DATE(@rateDay, 'YYYY-MM-DD')`,
    params: { rateDay: latest?.day ?? asAt },
  }
}
