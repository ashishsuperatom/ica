// Seed SQL Server and Oracle through the drivers their connectors use (their images have no client to pipe a script to).
//   node seed-drivers.mjs <mssql|oracle>
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../bridges/sqlserver/', import.meta.url))
const PW = 'Sa-live-2026!'
const which = process.argv[2]
const script = execFileSync(process.execPath, [new URL('./seed.mjs', import.meta.url).pathname, which], { encoding: 'utf8', maxBuffer: 64 << 20 })
if (which === 'mssql') {
  const { Connection, Request } = require('tedious')
  const connect = (database) => new Promise((ok, no) => { const c = new Connection({ server: 'localhost', authentication: { type: 'default', options: { userName: 'sa', password: PW } }, options: { port: 51433, database, encrypt: false, trustServerCertificate: true } }); c.on('connect', (e) => (e ? no(e) : ok(c))); c.connect() })
  const run = (c, sql) => new Promise((ok, no) => c.execSql(new Request(sql, (e) => (e ? no(e) : ok()))))
  const m = await connect('master'); await run(m, "IF DB_ID('sales') IS NULL CREATE DATABASE sales"); m.close()
  const c = await connect('sales')
  for (const stmt of script.split(/\nGO\n?/).map((x) => x.trim()).filter(Boolean)) await run(c, stmt)
  c.close()
} else {
  const oracledb = createRequire(new URL('../../bridges/oracle/', import.meta.url))('oracledb')
  const c = await oracledb.getConnection({ user: 'sales', password: PW, connectString: 'localhost:51521/FREEPDB1' })
  for (const stmt of script.split(/\n\/\n?/).map((x) => x.trim()).filter(Boolean)) await c.execute(stmt)
  await c.commit(); await c.close()
}
