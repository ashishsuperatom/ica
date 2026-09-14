// Checked against the 4 Month Summary: AU Jul–Oct 2026 come to 7,546,044 · 8,023,123 · 10,207,680 · 8,130,662.
export default () => ({
  sql: `SELECT b.* FROM {{budget}} b
         WHERE b.category_id = 5 AND b.account_number IN ('5005', '5102', '5010')`,
})
