// Budget amounts sit one per budget line per accounting period (budgetsmachine), under a header that says which
// subsidiary, department, account and category (budgets). A period is dated by its first day; only month periods
// carry amounts. Called with { from, to }, YYYY-MM-DD, to exclusive. Names come from joins, not BUILTIN.DF, which NetSuite
// evaluates on every budget line before any filter and which made a four-month read take minutes.
export default (ctx, { from, to }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT p.startdate                       AS period_start,
           b.subsidiary                      AS subsidiary_id,
           s.name                            AS subsidiary_name,
           b.department                      AS department_id,
           d.name                            AS department_name,
           b.category                        AS category_id,
           bc.name                           AS category_name,
           a.acctnumber                      AS account_number,
           a.accountsearchdisplayname        AS account_name,
           a.accttype                        AS account_type,
           c.symbol                          AS currency_code,
           TO_NUMBER(bm.amount)              AS amount
      FROM budgetsmachine bm
      JOIN budgets b ON b.id = bm.budget
      JOIN account a ON a.id = b.account
      JOIN accountingperiod p ON p.id = bm.period
      LEFT JOIN subsidiary s ON s.id = b.subsidiary
      LEFT JOIN department d ON d.id = b.department
      LEFT JOIN budgetcategory bc ON bc.id = b.category
      LEFT JOIN currency c ON c.id = b.currency
     WHERE p.isquarter = 'F' AND p.isyear = 'F'
       AND p.startdate >= TO_DATE(@from, 'YYYY-MM-DD') AND p.startdate < TO_DATE(@to, 'YYYY-MM-DD')`,
  params: { from, to },
})
