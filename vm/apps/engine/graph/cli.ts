// ── THE AGENTS' TOOLS FOR THE GRAPH ───────────────────────────────────────────────────────────────────────────
//
//   ./catalog [words]                      one line per program, or per program matching the words
//   ./program <name>                       one program in full: measures, dimensions, parameters, assumptions
//   ./define <dir> [--replace "<why>"]     define the program in <dir> (contract.json + program.mjs), or correct one
//   ./try <program> ['<request>']          ask a program directly, to check it while writing
//   ./ask '<message>'                      apply a message to this conversation's data session and answer it
//   ./find '<query>'                       find something the person was shown: {"row":3} · {"text":"acme"} · {"column":…,"equals":…}
//   ./members <relation> <dimension> [text]   which members of a dimension match what was typed
//
// Each wrapper is generated into the agent's workspace with the paths it needs; the agent passes only the arguments.

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { openProjectGraph } from './project.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const env = { dbDir: flag('db')!, projectDir: flag('project')!, managerUrl: flag('manager')!, home: flag('home')! }
const replace = flag('replace')
const [command, ...args] = argv

const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
const fail = (msg: string): never => { console.error(msg); process.exit(1) }
const json = (text: string | undefined, what: string) => {
  if (!text) return fail(`${what} is required`)
  try { return JSON.parse(text) } catch (e: any) { return fail(`${what} is not JSON: ${e.message}`) }
}

/** What an answer or result looks like, short enough to read: shapes, the first rows, the narration, the next steps. */
function summary(value: any, rows = 15): unknown {
  if (value && value.data && Array.isArray(value.views)) {
    return {
      narration: value.narration?.map((s: any) => s.text),
      views: value.views.map((v: any) => `${v.id}: ${v.component} of ${v.data} ${JSON.stringify(v.encode)}`),
      nextSteps: value.nextSteps?.map((n: any) => `${n.label} → ${JSON.stringify(n.message)}`),
      ...(value.dropped ? { droppedNextSteps: value.dropped } : {}),
      data: Object.fromEntries(Object.entries(value.data).map(([k, d]: [string, any]) => [k, summary(d, 5)])),
    }
  }
  if (value && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return { columns: value.columns.map((c: any) => `${c.name}${c.unit ? ` (${c.unit})` : ''}`), rows: value.rows.slice(0, rows),
             ...(value.rows.length > rows ? { more: value.rows.length - rows } : {}), ...(value.caveats?.length ? { caveats: value.caveats } : {}) }
  }
  return value
}

const readTurn = async (name: string) => (await readFile(join(env.home, name), 'utf8').catch(() => '')).trim()

const engine = await openProjectGraph(env)

if (command === 'program') {
  const all = engine.catalog()
  const text = args.join(' ').trim()
  const exact = all.find((e) => e.name.toLowerCase() === text.toLowerCase())
  if (!exact) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    const near = all.filter((e) => words.some((w) => e.name.toLowerCase().includes(w))).map((e) => e.name)
    fail(`there is no program "${text}"${near.length ? ` — did you mean ${near.map((n) => `"${n}"`).join(', ')}?` : ''} — ./catalog lists them`)
  }
  const e: any = exact, r = e.relation
  const params = Object.entries(e.params ?? {}).map(([k, v]: [string, any]) => `  ${k} — ${typeof v === 'string' ? v : v.description}`)
  const assumes = Object.entries(e.assumes ?? {}).map(([k, v]: [string, any]) => `  ${k} — ${v.description}${v.default !== undefined ? ` (default ${JSON.stringify(v.default)})` : ''}`)
  out([
    `${e.name} — ${e.kind}, returns ${e.returns}`, `  ${e.description}`,
    ...(r ? [`holds ${r.holds}${r.time ? `, over time (by day, week, month, quarter, year)` : ''}${r.grain ? `, one row per ${r.grain}` : ''}`,
             'measures:', ...Object.entries(r.measures).map(([m, d]: [string, any]) => `  ${m} — ${d.unit}, ${d.how}${d.description ? ` — ${d.description}` : ''}`),
             'dimensions:', ...Object.entries(r.dimensions).map(([n, d]: [string, any]) => `  ${n}${d.labelled ? ` (filter by name with ${n}_label)` : ''}${d.entity ? ` → ${d.entity}` : ''}${d.description ? ` — ${d.description}` : ''}`)] : []),
    ...(params.length ? ['parameters:', ...params] : []),
    ...(assumes.length ? ['assumes:', ...assumes] : []),
  ].join('\n'))
  process.exit(0)
}
if (command === 'catalog') {
  // A list, one line a program; ./program shows one in full. Every program's whole shape at once ran to hundreds of
  // lines, most of it about programs the question had nothing to do with.
  const all = engine.catalog()
  const text = args.join(' ').trim()
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = (e: any) => [e.name, e.description, ...Object.keys(e.relation?.measures ?? {}), ...Object.keys(e.relation?.dimensions ?? {})].join(' ').toLowerCase()
  const matching = all.filter((e) => words.every((w) => haystack(e).includes(w)))
  const line = (e: any) => {
    const r = e.relation
    const shape = r ? ` · ${Object.keys(r.measures).length} measures, ${Object.keys(r.dimensions).length} dimensions, ${r.holds}${r.time ? ' over time' : ''}` : ''
    const hits = words.length && r ? [...Object.keys(r.measures), ...Object.keys(r.dimensions)].filter((n) => words.some((w) => n.toLowerCase().includes(w))) : []
    return `${e.name} — ${e.kind}, returns ${e.returns}${shape}${hits.length ? ` · matches ${hits.join(', ')}` : ''}\n    ${e.description}`
  }
  out([...matching.map(line), '', `${matching.length} of ${all.length} programs${words.length ? ` matching "${text}"` : ''} — ./program <name> shows one program's measures, dimensions and parameters`].join('\n'))
  process.exit(0)
}
if (command === 'define') {
  const dir = args[0] ?? fail('usage: ./define <dir> [--replace "<why>"] — the directory holds contract.json and program.mjs')
  const at = isAbsolute(dir) ? dir : join(env.home, dir)
  const contract = json(await readFile(join(at, 'contract.json'), 'utf8').catch(() => fail(`${dir}/contract.json is missing`)), 'contract.json')
  const body = await readFile(join(at, 'program.mjs'), 'utf8').catch(() => fail(`${dir}/program.mjs is missing`))
  const r = await engine.define({ body, contract }, { by: `agent:${await readTurn('.agent') || 'unknown'}`, replace: replace !== undefined, reason: replace })
  out({ defined: r.name, hash: r.hash, new: r.created })
} else if (command === 'try') {
  const [program, request] = args
  if (!program) fail('usage: ./try <program> [\'<request json>\']')
  const r = await engine.call(program, request ? json(request, 'the request') : {}, { checks: 'thorough' })
  out({ call: r.callId, value: summary(r.value), caveats: engine.store.getCall(r.callId)?.caveats })
} else if (command === 'ask') {
  const message = json(args.join(' '), 'the message')
  const sessionId = await readTurn('.session') || fail('there is no data session for this conversation')
  const qid = await readTurn('.turn') || fail('there is no turn in progress here')
  if (!engine.sessions.exists(sessionId)) fail(`the data session ${sessionId} does not exist`)
  const r = await engine.sessions.apply(sessionId, message)
  await mkdir(join(env.home, 'out', qid), { recursive: true })
  await writeFile(join(env.home, 'out', qid, 'step.json'), JSON.stringify({ sessionId, step: r.step, refused: (r as any).refused, error: (r as any).error }, null, 2))
  if ((r as any).refused) out({ step: r.step, refused: (r as any).refused })
  else if ((r as any).error) out({ step: r.step, error: (r as any).error })
  else out({ step: r.step, state: r.state, answer: summary((r as any).value), caveats: engine.store.getCall((r as any).callId)?.caveats })
} else if (command === 'find') {
  const sessionId = await readTurn('.session') || fail('there is no data session for this conversation')
  out(engine.sessions.find(sessionId, json(args.join(' '), 'the query')))
} else if (command === 'members') {
  const [relation, dimension, ...text] = args
  if (!relation || !dimension) fail('usage: ./members <relation> <dimension> [text]')
  out(await engine.members(relation, { dimension, search: text.join(' ') || undefined }))
} else {
  fail(`unknown command "${command}" — catalog, program, define, try, ask, find, members`)
}
process.exit(0)
