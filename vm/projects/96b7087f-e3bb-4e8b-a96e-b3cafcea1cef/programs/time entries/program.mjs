// timebill holds about 130,000 lines a month: always read inside { from, to } (to exclusive). A line's actual
// time-based charges are summed per line first, because a few lines carry more than one.
export default (ctx, { from, to }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT tb.id                          AS entry_id,
           tb.trandate                    AS worked_on,
           tb.employee                    AS employee_id,
           BUILTIN.DF(tb.employee)        AS employee_name,
           tb.customer                    AS project_id,
           BUILTIN.DF(tb.customer)        AS project_name,
           tb.approvalstatus              AS approval_id,
           BUILTIN.DF(tb.approvalstatus)  AS approval_name,
           tb.isbillable                  AS billable,
           tb.isutilized                  AS utilised,
           tb.isproductive                AS productive,
           TO_NUMBER(tb.hours)            AS hours,
           ch.charge_currency             AS charge_currency,
           ch.charge_rate                 AS charge_rate,
           ch.charged_amount              AS charged_amount
      FROM timebill tb
      LEFT JOIN (SELECT c.timerecord, MAX(cc.symbol) AS charge_currency, MAX(TO_NUMBER(c.rate)) AS charge_rate, SUM(TO_NUMBER(c.amount)) AS charged_amount
                   FROM charge c LEFT JOIN currency cc ON cc.id = c.currency
                  WHERE c.use = 'Actual' AND c.chargetype = -13
                    AND c.chargedate >= TO_DATE(@from, 'YYYY-MM-DD') AND c.chargedate < TO_DATE(@to, 'YYYY-MM-DD')
                  GROUP BY c.timerecord) ch ON ch.timerecord = tb.id
     WHERE tb.trandate >= TO_DATE(@from, 'YYYY-MM-DD') AND tb.trandate < TO_DATE(@to, 'YYYY-MM-DD')`,
  params: { from, to },
})
