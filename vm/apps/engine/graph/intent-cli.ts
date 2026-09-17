// ── THE INTENT SIDE, AS AN AGENT REACHES IT ──────────────────────────────────────────────────────────────────
//
// The semantic graph is asked what is TRUE and what may legally combine. This is asked what is WANTED: what a
// person in this situation is deciding, what an answer has to carry to serve it, and what we learned the last time
// we went this way. It never returns a number.
//
//   intent '<the question, as asked>'   the intents this question may be, deepest first, each with what it
//                                       requires — and the states in force for this conversation
//   state                               the slice in force: what situation we are answering inside
//   state push|drop <id>                a move: the situation changed, and the change is recorded
//   watch [<g1:ref>]                    what we learned to watch for here, before exploring the same ground again
//   checks <intent id>                  the requirements as a list to check an answer against
//   suggest '<json>'                    what should be added — recorded, never applied
//   proposed                            suggestions waiting for a person
//
// A reference written here is checked against the semantic graph when it is stored, so nothing on this side can
// quietly hold a measure or a setting that does not exist.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IntentStore, intentFile, type Ref } from './intent-store.js'
import { MODEL, openSemanticGraph } from './semantic.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : (argv.splice(i, 2), argv[i] ?? undefined) || undefined }
const value = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
void flag
const env = { dbDir: value('db')!, projectDir: value('project')!, managerUrl: value('manager')!, home: value('home')! }
const asJson = argv.includes('--json') ? (argv.splice(argv.indexOf('--json'), 1), true) : process.env.SEMANTIC_TOOL_FORMAT === 'json'
// THE PLAIN FORM IS ASKING. Everything else is a named move, so a question needs no command word in front of it —
// a tool whose commonest use needs a keyword is a tool that gets read about instead of used.
const MOVES = new Set(['intent', 'state', 'watch', 'checks', 'suggest', 'proposed', 'history', 'seed'])
const [first, ...rest] = argv
const command = first && MOVES.has(first) ? first : 'intent'
const args = first && MOVES.has(first) ? rest : argv
const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
const fail = (m: string): never => { console.error(m); process.exit(1) }

if (argv.includes('-h') || argv.includes('--help')) {
  out(`intent '<the question, as asked>'   → what this question may be deciding, what serves it, and the situation in force
  state | state push <id> | state drop <id>   the slice of situation this conversation is answering inside
  watch [<g1:Object[.measure]>]               what to watch for around a node, learned from going this way before
  checks <intent id>                          what an answer must carry, as a list to check against
  suggest '<json>'                            {"op":"…","target":"…","args":{…},"reason":"…"} — recorded, never applied
  proposed                                    what is waiting for a person`)
  process.exit(0)
}

const store = new IntentStore(intentFile(env.dbDir))
const session = (await readFile(join(env.home, '.session'), 'utf8').catch(() => '')).trim() || 'none'
const who = (await readFile(join(env.home, '.agent'), 'utf8').catch(() => '')).trim() || 'agent'

/** A reference is only accepted if the semantic graph really holds it: the two sides must not drift apart. */
async function checker(): Promise<(ref: Ref) => string | null> {
  const graph = await openSemanticGraph(env as any)
  const m = graph.model(MODEL)
  return (ref) => {
    if (ref.startsWith('raw:')) return null                       // data the semantic graph does not model yet
    const body = ref.slice(3)
    if (body.startsWith('setting:')) return m.settings?.[body.slice(8)] === undefined ? `the graph has no setting "${body.slice(8)}"` : null
    if (body.startsWith('condition:')) return m.schema.conditions?.[body.slice(10)] ? null : `the graph has no condition "${body.slice(10)}"`
    const [object, measure] = body.split('.')
    const o = m.schema.objects[object!]
    if (!o) return `the graph has no node "${object}"`
    if (measure && !(o.kind === 'fact' && o.measures?.[measure])) return `${object} has no measure "${measure}"`
    return null
  }
}

if (command === 'intent') {
  const text = args.join(' ').trim() || fail("usage: intent '<the question, as asked>'")
  const found = store.intentsFor(text, { owner: who })
  const inForce = store.state(session)
  const shown = found.slice(0, 3).map((f) => ({
    id: f.intent.id, about: f.intent.label, level: f.intent.level, seenBefore: f.intent.seen,
    ...(f.intent.body as Record<string, unknown>),
    requires: f.requirements.map((r) => `${r.role}: ${r.ref ?? `${r.node?.label ?? '?'}${r.node ? ` [${r.node.id}]` : ''}`}`),
  }))
  if (asJson) out({ intents: shown, ...(found.length > 3 ? { more: found.length - 3 } : {}), state: inForce.map((s) => ({ id: s.id, is: s.label, level: s.level, seen: s.seen })) })
  else {
    const lines: string[] = []
    if (!shown.length) {
      // THE WORDS DID NOT REACH ANYTHING, WHICH IS THE FRONTIER, NOT AN ANSWER. Ranking by words is no use here, so
      // everything this graph holds is put in front of whoever understands the sentence, to judge.
      lines.push('nothing here was reached by those words — this is new ground. What this graph does hold:')
      for (const n of store.all()) lines.push(`    ${n.label}   [${n.id}] · met ${n.seen}×`)
      lines.push('    — if one of these is what is being decided, read it with: intent checks <id>')
      lines.push('    — if none is, answer from the graph and suggest the intent: intent suggest \'{"op":"add-intent","reason":"…","args":{…}}\'')
    }
    for (const s of shown) {
      lines.push(`${s.about}   [${s.id}] · ${s.level} · met ${s.seenBefore}×`)
      for (const r of s.requires) lines.push(`    ${r}`)
      for (const [k, v] of Object.entries(s)) if (!['id', 'about', 'level', 'seenBefore', 'requires'].includes(k)) lines.push(`    ${k}: ${Array.isArray(v) ? v.join(' · ') : String(v)}`)
    }
    lines.push('', inForce.length ? `in force: ${inForce.map((s) => `${s.label} [${s.id}]`).join(' · ')}` : 'in force: nothing — no situation has been pushed')
    out(lines.join('\n'))
  }
} else if (command === 'state') {
  const [move, id] = args
  if (!move) {
    const s = store.state(session)
    out(asJson ? s.map((x) => ({ id: x.id, is: x.label, level: x.level, seen: x.seen, ...x.body })) : (s.length ? s.map((x) => `${x.label}   [${x.id}] · ${x.level} · seen ${x.seen}×`).join('\n') : 'nothing in force'))
  } else if (move === 'push') { store.pushState(session, id ?? fail('usage: state push <id>'), who); out(`in force: ${store.state(session).map((s) => s.label).join(' · ')}`) }
  else if (move === 'drop') { store.dropState(session, id ?? fail('usage: state drop <id>'), who); out(`in force: ${store.state(session).map((s) => s.label).join(' · ') || 'nothing'}`) }
  else fail('usage: state | state push <id> | state drop <id>')
} else if (command === 'watch') {
  const about = args.join(' ').trim() || undefined
  const c = store.cautions(about)
  if (asJson) out(c.map((x) => ({ id: x.id, kind: x.kind, about: x.about, says: x.label, seen: x.seen, ...x.body })))
  else out(c.length ? c.map((x) => `${x.kind} · ${x.about}\n    ${x.label}${x.body.then ? `\n    → ${x.body.then}` : ''}  (seen ${x.seen}×)`).join('\n') : 'nothing learned about that yet')
} else if (command === 'checks') {
  const id = args[0] ?? fail('usage: checks <intent id>')
  const n = store.node(id) ?? store.all().find((x) => x.id === `intent:${id}` || x.id.endsWith(`:${id}`) || x.label === id)
    ?? fail(`there is no intent "${id}" — this graph holds ${store.all().map((x) => x.id).join(', ') || 'none'}`)
  const reqs = store.edges(n.id).out
  out(asJson ? { intent: n.id, about: n.label, checks: reqs.map((e) => ({ role: e.role, is: e.dst })), says: (n.body as any).says ?? [] }
    : [`an answer to "${n.label}" must:`, ...reqs.map((e) => `    ${e.role}  ${e.dst}`), ...(((n.body as any).says ?? []) as string[]).map((s) => `    say  ${s}`)].join('\n'))
} else if (command === 'suggest') {
  const raw = args.join(' ').trim() || fail(`usage: suggest '{"op":"…","target":"…","args":{…},"reason":"…"}'`)
  let x: any
  try { x = JSON.parse(raw) } catch (e: any) { fail(`that is not JSON: ${e.message}`) }
  if (!x.op || !x.reason) fail('a suggestion says what to do (op) and why (reason)')
  const id = store.propose(who, String(x.op), x.target ?? null, x.args ?? {}, String(x.reason))
  out(`suggestion ${id} recorded, not applied — a person decides. Answer with what the graph holds today, and say what differs.`)
} else if (command === 'proposed') {
  out(store.proposals())
} else if (command === 'history') {
  out(store.history())
} else if (command === 'seed') {
  // Writing this side is not an agent's job; this is how a person (or a seeding script) puts it there.
  const raw = args.join(' ').trim() || fail("usage: seed '<json>'")
  const ok = await checker()
  const plan = JSON.parse(raw) as { nodes?: any[]; edges?: any[]; approach?: any[]; state?: string[] }
  for (const n of plan.nodes ?? []) store.put(n, `seed:${who}`, n.reason)
  for (const e of plan.edges ?? []) store.link(e.src, e.role, e.dst, `seed:${who}`, ok)
  for (const a of plan.approach ?? []) store.learn(a, `seed:${who}`)
  for (const s of plan.state ?? []) store.pushState(session, s, `seed:${who}`)
  out(`seeded · ${(plan.nodes ?? []).length} nodes, ${(plan.edges ?? []).length} edges, ${(plan.approach ?? []).length} learned, ${(plan.state ?? []).length} pushed`)
} else {
  fail(`no such command "${command ?? ''}" — try --help`)
}
store.close()
