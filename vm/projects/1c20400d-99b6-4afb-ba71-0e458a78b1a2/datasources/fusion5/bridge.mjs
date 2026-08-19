// fusion5 bridge — NetSuite as a SQL source via SuiteQL over the REST API.
//
// NetSuite's SuiteQL IS SQL (Oracle-flavoured), so to the agent this is a kind:'sql' source — it writes
// SuiteQL, not raw HTTP. Auth is OAuth 2.0 M2M: a PS256 JWT (signed with the account's private key) is
// exchanged for a short-lived access token; queries POST to /query/v1/suiteql. The datasource-manager
// loads this via createBridge(); agents reach it only through query(id, sql, params).
//
// Ported from the client's NetSuite experiment (infra/netsuite/test.js). Dependency-free: the JWT is
// signed with node:crypto (RSA-PSS/SHA-256), so no jsonwebtoken dependency in the monorepo.

import { constants as cryptoConstants, sign as cryptoSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Load the project's .env (holds the NetSuite creds) so the bridge is self-contained regardless of which
// process the manager runs it in.
try { process.loadEnvFile(resolve(HERE, '../../.env')) } catch { /* rely on ambient env */ }

const ACCOUNT   = process.env.NETSUITE_ACCOUNT || ''                         // e.g. "1198206-sb2"
const CLIENT_ID = process.env.NETSUITE_CLIENT_ID || ''
const CERT_ID   = process.env.NETSUITE_CERT_ID || ''
const KEY_PATH  = process.env.NETSUITE_PRIVATE_KEY_PATH || './private.pem'
const SCOPES    = ['rest_webservices', 'suite_analytics']
const MAX_ROWS  = Number(process.env.NETSUITE_MAX_ROWS || 50000)            // safety cap on unbounded queries
const PAGE      = 1000                                                       // SuiteQL max page size

const base = ACCOUNT ? `https://${ACCOUNT}.suitetalk.api.netsuite.com` : ''
const TOKEN_URL   = `${base}/services/rest/auth/oauth2/v1/token`
const SUITEQL_URL = `${base}/services/rest/query/v1/suiteql`

const b64url = (buf) => Buffer.from(buf).toString('base64url')

// PS256 JWT (RSASSA-PSS, SHA-256, salt=32) signed with the account's private key — no external lib.
function clientAssertion(privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const header  = { alg: 'PS256', typ: 'JWT', kid: CERT_ID }
  const payload = { iss: CLIENT_ID, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = cryptoSign('sha256', Buffer.from(signingInput),
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
  return `${signingInput}.${b64url(sig)}`
}

export function createBridge() {
  let privateKey = ''
  try { privateKey = readFileSync(isAbsolute(KEY_PATH) ? KEY_PATH : resolve(HERE, KEY_PATH), 'utf8') } catch { /* not ready */ }

  let token = ''            // cached access token
  let tokenExp = 0          // epoch seconds it expires

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000)
    if (token && now < tokenExp - 60) return token                          // reuse until ~1 min before expiry
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion(privateKey),
    })
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body })
    const txt = await r.text()
    if (!r.ok) throw new Error(`NetSuite token failed (${r.status}): ${txt.slice(0, 300)}`)
    const j = JSON.parse(txt)
    token = j.access_token; tokenExp = now + Number(j.expires_in || 3600)
    return token
  }

  // Inline @name params as SuiteQL literals (agents write @name like the other SQL bridges). Analyst-authored
  // SQL against a sandbox; strings are single-quote escaped.
  function bind(sql, params) {
    if (!params || !Object.keys(params).length) return sql
    return sql.replace(/@(\w+)/g, (m, name) => {
      if (!(name in params)) return m
      const v = params[name]
      if (v == null) return 'NULL'
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      return `'${String(v).replace(/'/g, "''")}'`
    })
  }

  async function suiteql(q, offset) {
    const tok = await accessToken()
    const r = await fetch(`${SUITEQL_URL}?limit=${PAGE}&offset=${offset}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json', prefer: 'transient' },
      body: JSON.stringify({ q }),
    })
    const txt = await r.text()
    let j; try { j = JSON.parse(txt) } catch { j = txt }
    if (!r.ok) {
      const code = j?.['o:errorDetails']?.[0]?.['o:errorCode'] || j?.title || r.statusText
      throw new Error(`SuiteQL error (${r.status} ${code}): ${(typeof j === 'string' ? j : JSON.stringify(j)).slice(0, 400)}`)
    }
    return j   // { items, hasMore, count, offset, totalResults, links }
  }

  async function query(sql, params = {}) {
    const q = bind(sql, params)
    const rows = []
    let offset = 0
    // Page until NetSuite says no more, capped so an unbounded SELECT can't pull hundreds of thousands.
    for (;;) {
      const page = await suiteql(q, offset)
      for (const it of page.items || []) { delete it.links; rows.push(it) }   // drop NetSuite's per-row `links` metadata
      if (!page.hasMore || rows.length >= MAX_ROWS) break
      offset += PAGE
    }
    return rows
  }

  async function introspect() {
    // oa_tables is SuiteQL's own catalog of queryable tables. Return names + whatever metadata it exposes.
    let tables = []
    try {
      const rows = await query('SELECT * FROM oa_tables')
      tables = rows.map((r) => ({ name: r.table_name || r.tablename || r.name || r.id, ...r }))
    } catch { tables = [] }
    return { kind: 'sql', dialect: 'suiteql', tables }
  }

  return {
    id: 'fusion5',
    kind: 'sql',
    dialect: 'suiteql',
    description:
      'This is ORACLE NETSUITE — apply what you know about its schema, record types, and SuiteQL. ' +
      'PRIMARY query mode (use this for now): SuiteQL — Oracle-flavoured SQL over the REST API. Dialect: ' +
      'FETCH FIRST n ROWS ONLY (not LIMIT/TOP), ROWNUM, standard SQL functions; bind values with @name. ' +
      'Core tables: customer, vendor, item, transaction (+ transactionline), invoice, salesorder, ' +
      'vendorbill, account, department, location, subsidiary, currency, employee — and everything listed ' +
      'in oa_tables. NOTE: NetSuite ALSO exposes REST Record APIs at /services/rest/record/v1/<recordType> ' +
      'for data SuiteQL cannot reach — that path is NOT wired into this bridge yet, so use SuiteQL for now; ' +
      'API support comes later.',
    ready() { return !!(ACCOUNT && CLIENT_ID && CERT_ID && privateKey) },
    query,
    introspect,
  }
}
