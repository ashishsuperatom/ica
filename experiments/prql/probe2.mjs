import prqljs from 'prql-js'
const { compile, CompileOptions } = prqljs
// row-limit + sort: this is where MSSQL (TOP/OFFSET) and others (FETCH FIRST/LIMIT) diverge
const PRQL = `from customer\nsort {-id}\ntake 5\nselect {id, companyname}`
for (const target of ['sql.mssql', 'sql.generic', 'sql.postgres']) {
  try { console.log(`--- ${target} ---\n` + compile(PRQL, new CompileOptions({ target, signature_comment:false })).trim()) }
  catch (e) { console.log(`--- ${target} ---\nERR ${String(e).slice(0,150)}`) }
}
