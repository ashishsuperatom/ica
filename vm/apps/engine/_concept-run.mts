import { createAnalyst } from './agents/analyst/index.ts'
import { NodeStore } from '@superatom/node-store'
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/amigoz/broken/superatom/coding-agent/vm/.state'
const PROJECT = '96b7087f-e3bb-4e8b-a96e-b3cafcea1cef'
const WS = join(ROOT, PROJECT)
const BANK = '/Users/amigoz/Downloads/questions-bank(Fusion5).csv'
const SP = '/private/tmp/claude-501/-Users-amigoz-broken-superatom-coding-agent/8206073b-6acc-4a94-8106-4407eef18684/scratchpad'
const OUT = join(SP, 'fusion5-bank-concepts.json')
const LOG = join(SP, 'concept-run.log')
const log = (m: string) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { appendFileSync(LOG, l + '\n') } catch {} }

function parseCsv(t: string) { const rows: string[][] = []; let f = '', row: string[] = [], q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c } else { if (c === '"') q = true; else if (c === ',') { row.push(f); f = '' } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); if (row.some(x => x.trim())) rows.push(row); row = []; f = '' } else f += c } } if (f || row.length) { row.push(f); rows.push(row) } return rows }
function liftPrql(dir: string) { const steps: any[] = []; if (!existsSync(dir)) return steps; const walk = (d: string) => { for (const f of readdirSync(d)) { const fp = join(d, f); if (statSync(fp).isDirectory()) walk(fp); else if (f.endsWith('.ts')) { const src = readFileSync(fp, 'utf8'); const re = /ctx\.query\(\s*['"]([^'"]+)['"]\s*,\s*(['"`])([\s\S]*?)\2/g; let m; while ((m = re.exec(src))) { const prql = m[3].replace(/\$\{[^}]+\}/g, '<param>').replace(/'\s*\+\s*'/g, '').split('\n').map(s => s.trim()).filter(Boolean).join(' | '); if (/\bfrom\b/.test(prql)) steps.push({ do: '', source: m[1], prql }) } } } }; try { walk(dir) } catch {}; return steps }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
const rj = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

;(async () => {
  const rows = parseCsv(readFileSync(BANK, 'utf8')); rows.shift()
  let qs = rows.map(r => (r[1] || '').trim()).filter(Boolean)
    .filter(q => q.length >= 20 && /[a-z]/i.test(q) && !/^(afasd|clear|option|hey grok|what (info|llm|dataset)|1\.|for these|since project|now (can|why)|yes |else$|then |just give|give me few|can you list down projects$)/i.test(q))
  const seen = new Set<string>(); qs = qs.filter(q => { const k = q.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').replace(/'[^']+'/g, "'X'"); if (seen.has(k)) return false; seen.add(k); return true })
  log(`distinct fusion5 questions to build: ${qs.length}`)
  const sources = await fetch('http://localhost:4020/sources').then(r => r.json()).then((j: any) => j.sources).catch(() => [])
  const store = new NodeStore(join(WS, 'db', 'project.sqlite'))
  const analyst = await createAnalyst({ root: ROOT, projectId: PROJECT, sources, managerUrl: 'http://localhost:4020', ica: { harness: 'claude-code', model: 'claude-sonnet-5' } } as any)
  const concepts: any[] = existsSync(OUT) ? rj(OUT) || [] : []
  const done = new Set(concepts.map((c: any) => c.question))
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]; if (done.has(q)) { log(`[${i + 1}/${qs.length}] (already) ${q.slice(0, 60)}`); continue }
    log(`[${i + 1}/${qs.length}] ASK: ${q.slice(0, 80)}`)
    try {
      const qid = `cbuild-${Date.now()}-${i}`
      const TO = Symbol('to')
      const r: any = await Promise.race([analyst.ask(q, {}, { qid }), new Promise(res => setTimeout(() => res(TO), 10 * 60 * 1000))])
      if (r === TO) { log('   TIMEOUT (10m) — reset session + skip'); try { (analyst as any).session?.reset?.() } catch {}; continue }
      const built = rj(join(WS, 'out', qid, 'built.json'))
      if (!built?.programDir) { log(`   no program (status ${r?.answer?.status ?? '?'}) — skip`); continue }
      const compute = liftPrql(join(WS, built.programDir))
      const ans = typeof r?.answer?.answer === 'string' ? r.answer.answer : ''
      const concept = { question: q, phrase: q, what: ans.slice(0, 160), program: built.programDir, params: built.params ?? {}, computeSteps: compute.length, category: r?.category }
      concepts.push(concept); writeFileSync(OUT, JSON.stringify(concepts, null, 2))
      if (compute.length) store.putNode({ id: 'concept:' + slug(q), kind: 'concept', label: q.slice(0, 80), summary: ans.slice(0, 160),
        props: { strong: true, phrase: q, what: ans.slice(0, 160), entities: [], strategy: `Answer "${q}" — see program ${built.programDir}.`, compute, represent: { idea: 'from ' + built.programDir }, review: { checks: [] }, scope: 'global', meta: { source: 'fusion5', mintedFrom: built.programDir, category: r?.category } } } as any)
      log(`   ✓ ${built.programDir} · ${compute.length} prql steps · ${concepts.length} total`)
    } catch (e: any) { log(`   ERR ${e?.message ?? e}`) }
  }
  log(`DONE. concepts built: ${concepts.length} → ${OUT}`)
  process.exit(0)
})().catch(e => { log('FATAL ' + (e?.message ?? e)); process.exit(1) })
