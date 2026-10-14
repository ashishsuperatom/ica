// NetSuite bridge — NetSuite as a SQL source via SuiteQL over the REST API (the connector 'netsuite').
//
// NetSuite's SuiteQL IS SQL (Oracle-flavoured), so to the agent this is a kind:'sql' source — it writes
// SuiteQL, not raw HTTP. Auth is OAuth 2.0 M2M: a PS256 JWT (signed with the account's private key) is
// exchanged for a short-lived access token; queries POST to /query/v1/suiteql. The datasource-manager
// loads this via createBridge({ settings, secrets }) — the project's NetSuite connection, from the platform (settings:
// account, clientId, certId, maxRows; secrets: privateKey, the PEM itself); agents reach it only through query(id, sql, params).
//
// Dependency-free: the JWT is signed with node:crypto (RSA-PSS/SHA-256), so no jsonwebtoken dependency.

import { constants as cryptoConstants, sign as cryptoSign } from 'node:crypto'
const SCOPES    = ['rest_webservices', 'suite_analytics']
const PAGE      = 1000                                                       // SuiteQL max page size
const SUITEQL_TABLES = ['customer', 'vendor', 'item', 'transaction', 'transactionline', 'invoice', 'salesorder', 'vendorbill', 'account', 'department', 'location', 'subsidiary', 'currency', 'employee', 'timebill', 'job']
// The connection's settings, set by createBridge (one bridge per loaded module: the manager imports it afresh each time).
let ACCOUNT = '', CLIENT_ID = '', CERT_ID = '', MAX_ROWS = 50000, base = '', TOKEN_URL = '', SUITEQL_URL = ''

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

export function createBridge({ settings = {}, secrets = {} } = {}) {
  ACCOUNT = String(settings.account ?? '')                                   // e.g. "1198206-sb2"
  CLIENT_ID = String(settings.clientId ?? '')
  CERT_ID = String(settings.certId ?? '')
  MAX_ROWS = Number(settings.maxRows ?? 50000)                               // safety cap on unbounded queries
  base = ACCOUNT ? `https://${ACCOUNT}.suitetalk.api.netsuite.com` : ''
  TOKEN_URL = `${base}/services/rest/auth/oauth2/v1/token`
  SUITEQL_URL = `${base}/services/rest/query/v1/suiteql`
  const privateKey = String(secrets.privateKey ?? '')

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
    // NetSuite's ODBC catalog (oa_tables) is EMPTY over the REST SuiteQL endpoint. The record metadata-catalog
    // is the definitive list of every queryable record type (standard + custom) — one GET, same OAuth.
    let tables = []
    try {
      const tk = await accessToken()
      const r = await fetch(`${base}/services/rest/record/v1/metadata-catalog`, { headers: { authorization: `Bearer ${tk}`, accept: 'application/json' } })
      if (r.ok) { const j = await r.json(); tables = (j.items || []).map((x) => ({ name: String(x.name || '') })).filter((t) => t.name) }
    } catch { tables = [] }
    // Tables SuiteQL answers that the record catalog does not list (the analytics tables): named here, where the
    // source is known, so every index of this source has them.
    for (const name of SUITEQL_TABLES) if (!tables.some((t) => t.name === name)) tables.push({ name })
    return { kind: 'sql', dialect: 'suiteql', tables }
  }

  return {
    id: 'netsuite',
    kind: 'sql',
    dialect: 'suiteql',
    description:
      'This is NetSuite — the engine is SuiteQL (Oracle-flavoured SQL). Write SuiteQL directly: canonical SQL ' +
      'covers most things (select, filter, sort, group, aggregate, pagination); use NetSuite/Oracle-specific ' +
      'constructs where needed (ROWNUM to bound a scan, BUILTIN.DF for a display value, a record-specific join). ' +
      'Bind values with @name. Core tables: customer, vendor, item, transaction (+transactionline), invoice, ' +
      'salesorder, vendorbill, account, department, location, subsidiary, currency, employee. NetSuite restricts ' +
      'some searches; if one is "unsupported", restructure it.',
    ready() { return !!(ACCOUNT && CLIENT_ID && CERT_ID && privateKey) },
    query,
    introspect,
  }
}
