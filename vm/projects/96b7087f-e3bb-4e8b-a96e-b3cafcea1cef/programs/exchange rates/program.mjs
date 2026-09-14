// NetSuite's currencyrate holds one rate per pair per day: basecurrency is what the rate converts to, and
// transactioncurrency × exchangerate = basecurrency. The latest day on or before @asAt applies to every pair.
export default (ctx, { asAt }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT tc.symbol AS from_code, bc.symbol AS to_code, TO_NUMBER(r.exchangerate) AS rate
      FROM currencyrate r
      JOIN currency tc ON tc.id = r.transactioncurrency
      JOIN currency bc ON bc.id = r.basecurrency
     WHERE r.effectivedate = (SELECT MAX(x.effectivedate) FROM currencyrate x WHERE x.effectivedate <= TO_DATE(@asAt, 'YYYY-MM-DD'))`,
  params: { asAt },
})
