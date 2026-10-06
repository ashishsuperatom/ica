#!/usr/bin/env node
// UI REVIEW — every console and Workspace page, at every width, from production with real data, checked for the mistakes
// that kept reaching the person (see checks.mjs) and laid side by side with the last accepted run.
//
//   node scripts/ui-review/run.mjs login              open the review Chrome to sign in (once; the profile keeps it)
//   node scripts/ui-review/run.mjs config app=<url>   set the Workspace's address (and project, console, domain, concept, agent)
//   node scripts/ui-review/run.mjs run [filter]       capture and check every page (or those whose key contains filter)
//   node scripts/ui-review/run.mjs accept             make the last run the one the next is compared with
//
// Everything is kept in ~/.superatom/review — screenshots hold real data, so never in the repo. Read-only: a page's steps
// only select and open things.

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch } from './cdp.mjs'
import { CHECKS } from './checks.mjs'
import { PAGES, WIDTHS } from './pages.mjs'

const HOME = join(homedir(), '.superatom', 'review')
const PROFILE = join(HOME, 'chrome')
const CONFIG = join(HOME, 'config.json')
const DEFAULTS = { console: 'https://superadmin.superatom.site', org: '', project: 'fe6bd230-9ee3-4fe1-bf53-400c20d81fd3', app: '', domain: 'pmo health', concept: 'The rule', agent: 'pmo-health' }
const config = () => ({ ...DEFAULTS, ...(existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {}) })
const fill = (s, c) => s.replace(/\{(\w+)\}/g, (_, k) => c[k] ?? '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const [cmd = 'run', ...rest] = process.argv.slice(2)
mkdirSync(HOME, { recursive: true })

if (cmd === 'config') {
  const c = config()
  for (const kv of rest) { const i = kv.indexOf('='); if (i > 0) c[kv.slice(0, i)] = kv.slice(i + 1) }
  writeFileSync(CONFIG, JSON.stringify(c, null, 2)); console.log(c); process.exit(0)
}

if (cmd === 'login') {
  const c = config()
  const { proc } = await launch({ profile: PROFILE, headless: false, url: `${c.console}/o/${c.org}/p/${c.project}` })
  console.log(`Sign in, in the window that opened${c.app ? `, then open ${c.app}/w and sign in there too` : ''}. Close the window when done.`)
  await new Promise((r) => proc.on('exit', r)); process.exit(0)
}

if (cmd === 'accept') {
  const last = latest(); if (!last) { console.log('no run to accept'); process.exit(1) }
  rmSync(join(HOME, 'baseline'), { recursive: true, force: true }); cpSync(last, join(HOME, 'baseline'), { recursive: true })
  console.log(`accepted ${last}`); process.exit(0)
}

function latest() {
  const runs = existsSync(join(HOME, 'runs')) ? readdirSync(join(HOME, 'runs')).sort() : []
  return runs.length ? join(HOME, 'runs', runs[runs.length - 1]) : null
}

// ── run ──
const c = config()
const filter = rest[0] ?? ''
const pages = PAGES.filter((p) => (!p.app || c.app) && (!filter || p.key.includes(filter)))
const skipped = PAGES.filter((p) => p.app && !c.app).map((p) => p.key)
const dir = join(HOME, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(join(dir, 'shots'), { recursive: true })
const { client, stop } = await launch({ profile: PROFILE })
const errors = []
client.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails.text)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
})
await client.send('Runtime.enable'); await client.send('Page.enable')

/** Until the page has settled: loaded, no skeleton rows showing, then a moment more. */
// Busy: not loaded, a skeleton row or a spinner showing, or the sign-in splash; then the page must go quiet (no change to
// its DOM for 800ms) before it is captured. Nothing here knows a page's own loading words.
const BUSY = `(() => {
  if (document.readyState !== 'complete') return true
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight }
  if ([...document.querySelectorAll('.sa-skeleton')].some(shown)) return true
  if ([...document.querySelectorAll('.sa-spin, .sa-spinner, [class*="spin"], [class*="loader"]')].some((e) => getComputedStyle(e).animationName !== 'none' && shown(e))) return true
  return /Sign in to the admin console|Signing in…/.test(document.body.innerText)
})()`
const QUIET = `new Promise((done) => { let t = setTimeout(fin, 800); const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, 800) }); o.observe(document.body, { subtree: true, childList: true, characterData: true }); const cap = setTimeout(fin, 6000); function fin() { o.disconnect(); clearTimeout(cap); done(true) } })`
async function settle(maxMs = 30000) {
  const t = Date.now()
  for (;;) {
    const busy = await client.eval(BUSY).catch(() => true)
    if (!busy) { await client.eval(QUIET).catch(() => {}); if (!await client.eval(BUSY).catch(() => true)) return true }
    if (Date.now() - t > maxMs) return false
    await sleep(250)
  }
}
const signedOut = () => client.eval(`!!document.querySelector('.cl-signIn-root, .cl-signIn-start') || /Welcome back! Please sign in|Sign in to the admin console/.test(document.body.innerText)`).catch(() => false)
async function step(s) {
  if (s.wait) return sleep(s.wait)
  const text = s.click ? fill(s.click, c) : null
  const ok = await client.eval(`(() => {
    const els = ${s.clickSelector ? `[...document.querySelectorAll(${JSON.stringify(s.clickSelector)})]` : `[...document.querySelectorAll('button, a, [role="button"]')].filter((b) => b.textContent.trim().toLowerCase().startsWith(${JSON.stringify((text ?? '').toLowerCase())}))`}
    const el = els.find((e) => e.getBoundingClientRect().width > 0); if (el) { el.scrollIntoView({ block: 'center' }); el.click() } return !!el })()`)
  if (!ok) throw new Error(`nothing to click for ${s.click ?? s.clickSelector}`)
}

const report = []
for (const w of WIDTHS) {
  await client.send('Emulation.setDeviceMetricsOverride', { width: w.width, height: w.height, deviceScaleFactor: 1, mobile: w.width < 500 })
  for (const p of pages) {
    const url = fill(p.url, c)
    const entry = { page: p.key, width: w.name, url, issues: [], errors: [] }
    errors.length = 0
    try {
      // navigate returns before the new page replaces the old one: wait for the new one's load, then for it to settle
      const loaded = new Promise((r) => { const off = client.on((m) => { if (m.method === 'Page.loadEventFired') { off(); r() } }); setTimeout(() => { off(); r() }, 20000) })
      await client.send('Page.navigate', { url })
      await loaded
      if (!await settle()) entry.issues.push({ kind: 'loading', what: 'still loading after 30s' })
      if (await signedOut()) { entry.issues.push({ kind: 'signed-out', what: 'the review profile is not signed in here — run login' }) }
      else for (const s of p.steps ?? []) { await step(s); if (!s.wait) await settle(8000) }
      entry.issues.push(...await client.eval(`(${CHECKS})()`))
    } catch (e) { entry.issues.push({ kind: 'failed', what: String(e.message ?? e) }) }
    entry.errors = [...new Set(errors)].slice(0, 10)
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    entry.shot = `shots/${p.key}--${w.name}.png`
    writeFileSync(join(dir, entry.shot), Buffer.from(shot.data, 'base64'))
    report.push(entry)
    const n = entry.issues.length + entry.errors.length
    console.log(`${n ? '✗' : '✓'} ${w.name.padEnd(7)} ${p.key}${n ? ` — ${[...entry.issues.map((i) => i.kind), ...entry.errors.map(() => 'error')].join(', ')}` : ''}`)
  }
}
await stop()
writeFileSync(join(dir, 'report.json'), JSON.stringify({ at: Date.now(), config: { ...c }, skipped, report }, null, 2))
writeFileSync(join(dir, 'index.html'), gallery(report, existsSync(join(HOME, 'baseline', 'report.json'))))
const kinds = {}
for (const e of report) for (const i of e.issues) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1
const errs = report.reduce((n, e) => n + e.errors.length, 0)
console.log(`\n${report.length} shots · ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no issues'}${errs ? ` · ${errs} page errors` : ''}${skipped.length ? ` · skipped ${skipped.length} Workspace pages (set app= with config)` : ''}`)
console.log(`open ${join(dir, 'index.html')}`)
process.exit(0)

function gallery(report, hasBase) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
  const byPage = new Map()
  for (const e of report) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e])
  const marks = (e) => e.issues.filter((i) => i.at).map((i) => `<i class="m m-${i.kind}" style="left:${i.at.x}px;top:${i.at.y}px;width:${Math.max(6, i.at.w)}px;height:${Math.max(6, i.at.h)}px" title="${esc(i.what)}"></i>`).join('')
  const rows = [...byPage].map(([page, shots]) => `<section><h2>${esc(page)}</h2>${shots.map((e) => {
    const bad = e.issues.length + e.errors.length
    return `<div class="row ${bad ? 'bad' : ''}"><h3>${esc(e.width)} <a href="${esc(e.url)}">${esc(e.url)}</a></h3><div class="pair">
      ${hasBase ? `<figure><figcaption>accepted</figcaption><img src="../../baseline/${esc(e.shot)}" loading="lazy"></figure>` : ''}
      <figure><figcaption>now</figcaption><div class="shot"><img src="${esc(e.shot)}" loading="lazy">${marks(e)}</div></figure>
      <ul>${e.issues.map((i) => `<li class="k-${i.kind}"><b>${esc(i.kind)}</b> ${esc(i.what)}</li>`).join('')}${e.errors.map((x) => `<li class="k-error"><b>error</b> ${esc(x)}</li>`).join('')}${bad ? '' : '<li class="ok">no issues</li>'}</ul></div></div>`
  }).join('')}</section>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>UI review</title><style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f4f6f8;color:#1d2433}h1{margin:0 0 16px}h2{margin:32px 0 8px}h3{font-size:13px;font-weight:600;margin:0 0 8px}h3 a{font-weight:400;color:#667;margin-left:8px}
  .row{background:#fff;border:1px solid #e1e6ec;border-radius:10px;padding:12px;margin:8px 0}.row.bad{border-color:#e9a39b}.pair{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}
  figure{margin:0}figcaption{font-size:12px;color:#667}img{display:block;max-width:none;border:1px solid #e1e6ec}.shot{position:relative}
  .m{position:absolute;outline:2px solid #d92d20;background:rgba(217,45,32,.12)}.m-flush{outline-color:#dc6803;background:rgba(220,104,3,.12)}.m-overlap{outline-color:#7a5af8}
  ul{list-style:none;margin:0;padding:0;min-width:280px;max-width:420px;font-size:13px}li{padding:3px 0;border-bottom:1px solid #f0f2f5}li b{display:inline-block;min-width:64px;color:#b42318}.k-flush b{color:#b54708}.ok{color:#067647}
  </style><h1>UI review</h1>${rows}`
}
