import prqljs from 'prql-js'
const { compile } = prqljs
const q = 'from customer | sort {-id} | take 5 | select {id, companyname}'
for (const t of ['sql.mssql','sql.oracle','sql.postgres','sql.sqlite']) {
  try { console.log(`--- header ${t} ---\n` + compile(`prql target:${t}\n${q}`).replace(/\n-- Generated.*/s,'').trim()) }
  catch (e) { console.log(`--- ${t} ---\nERR ${String(e).slice(0,160)}`) }
}
