// Reads the facts (facts.mjs) the dashboard stands on. The engine places a domain's programs in a folder of their own
// (ctx.domain — the files, settings.json and the data seam, kept to the composition graph as it is now); this file
// runs them there and reads their JSON rows.
//
// A run is remembered for five minutes by program, arguments and the composition it was placed from, so the blocks
// of one screen read the source once. Every run is recorded for the answer: which program, which arguments, how many
// rows, how long, and what it said on stderr (a read that reached the row limit).

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FACTS } from './facts.mjs'

/** What a view asks of a paged program: totals by some columns, or one page in an order; and conditions. */
function pagedArgs(name, { totals, page, size, order, where = [], distinct = [], max = [], min = [], ratio = [], having = [], pivot }) {
  if (!totals && !page) throw new Error(`${name} answers in totals and pages: ask it for those, never every row`)
  const list = (flag, xs) => (xs.length ? [flag, xs.join(',')] : [])
  return [
    ...(totals ? ['--totals', totals.join(',')] : []), ...list('--distinct', distinct), ...list('--max', max), ...list('--min', min),
    ...ratio.flatMap((r) => ['--ratio', typeof r === 'string' ? r : `${r.name}=${r.num}/${r.den}`]),
    ...(pivot ? ['--pivot', `${pivot.column}=${pivot.values.join(',')}`] : []),
    ...having.flatMap((h) => ['--having', h]),
    ...(page ? ['--page', page, ...(size ? ['--size', size] : []), ...(order ? ['--order', order] : [])] : []), ...where.flatMap((w) => ['--where', w]),
  ]
}

const TTL = 5 * 60 * 1000
const memo = new Map()   // stamp|program|args → { at, promise }

function run(dir, program, args, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [program, ...args], { cwd: dir, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } }, (err, stdout, stderr) => {
      const notes = String(stderr ?? '').split('\n').filter((l) => l.startsWith('NOTE: ')).map((l) => l.slice(6))
      if (err) return reject(new Error(`${program} ${args.join(' ')} failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`))
      if (raw) return resolve({ rows: String(stdout), notes })
      try { resolve({ rows: JSON.parse(stdout), notes: [...new Set(notes)] }) } catch (e) { reject(new Error(`${program} did not print JSON: ${e.message}`)) }
    })
  })
}

/** The facts for one answer: rows by name, the settings, and the record of every run. `ctx.domain` is the engine's seam. */
export function factsFor(ctx) {
  if (typeof ctx.domain !== 'function') throw new Error('this engine cannot place a domain\'s programs (ctx.domain)')
  const calls = []
  const placed = new Map()
  const place = (domain) => placed.get(domain) ?? placed.set(domain, ctx.domain(domain)).get(domain)
  return {
    calls,
    /** What one fact's program prints: its rows, or for a program the source runs, totals or a page. The same program
     *  with the same arguments inside five minutes is read once. */
    async read(name, params = {}) {
      const f = FACTS[name]
      if (!f) throw new Error(`there is no fact "${name}"`)
      const { dir, used } = await place(f.domain)
      const args = [...f.args(params), ...(f.paged && !params.latest ? pagedArgs(name, params) : [])].map(String)
      const key = `${JSON.stringify(used)}|${f.program}|${args.join(' ')}`
      let hit = memo.get(key)
      const fresh = !hit || Date.now() - hit.at > TTL
      if (fresh) { hit = { at: Date.now(), promise: run(dir, f.program, args) }; memo.set(key, hit); hit.promise.catch(() => memo.delete(key)) }
      const started = Date.now()
      const got = await hit.promise
      calls.push({ fact: name, program: f.program, args, rows: Array.isArray(got.rows) ? got.rows.length : null, ms: Date.now() - started, remembered: !fresh, ...(got.notes.length ? { notes: got.notes } : {}) })
      return { data: got.rows, notes: got.notes }
    },
    /** A program asked something about itself (--help, --columns), not remembered: for checking what it is. */
    async probe(name, flag, params = {}) {
      const f = FACTS[name]
      if (!f) throw new Error(`there is no fact "${name}"`)
      const { dir } = await place(f.domain)
      return run(dir, f.program, [...f.args(params), flag].map(String), { raw: flag === '--help' })
    },
    /** Every setting the domains' compositions give, by name. */
    async settings() {
      const out = {}
      for (const d of [...new Set(Object.values(FACTS).map((f) => f.domain))]) { const { dir } = await place(d); Object.assign(out, JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))) }
      return out
    },
    /** A setting of the organisation, as the domain's composition gives it (settings.json in its folder). */
    async setting(name, domain) {
      const domains = domain ? [domain] : [...new Set(Object.values(FACTS).map((f) => f.domain))]
      for (const d of domains) {
        const { dir } = await place(d)
        const all = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
        if (name in all) return all[name]
      }
      throw new Error(`no domain gives the setting "${name}"`)
    },
  }
}
