import prqljs from 'prql-js'
const { compile, CompileOptions } = prqljs
const PRQL = `
from customer
filter isinactive == "F"
aggregate { n = count this }
`
for (const target of ['sql.mssql', 'sql.ansi', 'sql.generic', 'sql.postgres']) {
  try {
    const sql = compile(PRQL, new CompileOptions({ target, signature_comment: false }))
    console.log(`\n===== ${target} =====\n${sql}`)
  } catch (e) { console.log(`\n===== ${target} =====\nERR: ${String(e).slice(0,200)}`) }
}
