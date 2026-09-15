// ── semantic-graph: THE ONE TOOL FOR WORKING ON A SEMANTIC GRAPH (MODELING.md) ──────────────────────────────────
//
//   semantic-graph <command> [arguments] [--flags]
//
// People and agents use the same commands. A change goes through an operation of the model store, which checks it
// and records it; nothing here writes nodes directly. Reading commands draw the graph as patterns, or JSON with --json.
//
// Where: --db <file> (else $SEMANTIC_GRAPH_DB, else <$ENGINE_PROJECT_DIR>/db/semantic-graph.sqlite) and --model <name>
// (else $SEMANTIC_MODEL, else "model"). Who and why, kept with every change: --by, --reason, --from.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ModelStore, operationsFor, type Operation } from './modelstore.js'
import { catalog, dimensions, conformedDimensions, node, paths } from './discovery.js'
import { catalogText, dimensionsText, nodeText, pathsText } from './patterns.js'
import { schemaProblems } from './schema.js'
import { sourcesProblems } from './producers.js'

type Flags = Record<string, string | true>
const COMMANDS: Record<string, { usage: string; does: string }> = {
  'prompt':            { usage: 'prompt [--json]', does: 'the guide an agent needs to work with this tool, versioned by its content' },
  'models':            { usage: 'models', does: 'the models in this store' },
  'create-model':      { usage: 'create-model <name>', does: 'a new, empty model' },
  'add-entity':        { usage: 'add-entity <Name> [--description] [--synonyms a,b] [--members key=label,…] [--names name=key,…] [--history current]', does: 'a thing with identity' },
  'add-calendar':      { usage: 'add-calendar <Name> --level day|week|month|quarter|year [--fiscal <json>] [--periods <json>]', does: 'a calendar level' },
  'add-fact':          { usage: 'add-fact <Name> [--description] [--synonyms a,b] [--history current]', does: 'recorded events at a grain' },
  'add-arrow':         { usage: 'add-arrow <Owner.role> <Target> [--kind grain|belongs|as-of|version|rollup|self] [--partial] [--synonyms a,b]', does: 'a link from one object to another' },
  'add-measure':       { usage: 'add-measure <Fact.name> --unit <u> --kind flow|stock|value-per-unit --aggregate <sum|count|count distinct|min|max|average|median|weighted average> [--currency path.to.currency | --currency-attribute a] [--of arrow] [--weight measure] [--versions arrow] [--over-time last|first|average] [--synonyms a,b] [--description]', does: 'a number on a fact' },
  'add-attribute':     { usage: 'add-attribute <Owner.name> --type text|date|number|flag [--members a,b] [--synonyms a,b] [--description]', does: 'a value an entity or fact carries' },
  'add-condition':     { usage: 'add-condition <name> --on <Object> --where <json filters> [--description] [--synonyms a,b]', does: 'a named condition' },
  'add-equation':      { usage: 'add-equation <Object> <path.one> <path.two>', does: 'two paths that must agree' },
  'set':               { usage: 'set <id> <property> <value | json> | set <id> <property> --unset', does: 'a property: description, synonyms, members, names, grain, keptTo, history, defaults, unit, …' },
  'rename':            { usage: 'rename <id> <new name>', does: 'rename, rewriting everything that refers to it' },
  'remove':            { usage: 'remove <id>', does: 'remove; refused while anything refers to it' },
  'promote-attribute': { usage: 'promote-attribute <Owner.attribute> <Entity>', does: 'turn an attribute into an entity and an arrow to it' },
  'bind':              { usage: 'bind <Object> --source <id> (--sql <text|@file> | --program <name>) [--key col] [--label col] [--time col] [--arrows <json>] [--attributes <json>] [--measures <json>] [--history <json>] [--params <json>] [--time-zone z]', does: 'where an object\'s rows are' },
  'add-program':       { usage: 'add-program <name> --produces <Object> --code <@file> [--sources a,b] [--objects A,B] [--description]', does: 'a program that produces an object\'s rows' },
  'set-setting':       { usage: 'set-setting <key> <value | json> | set-setting <key> --unset', does: 'an organisation setting' },
  'set-conversion':    { usage: 'set-conversion --fact <Fact> --from <arrow> --to <arrow> --day <arrow> --rate <measure> --at row|end', does: 'how money converts between currencies' },
  'overview':          { usage: 'overview', does: 'every fact, entity, condition and calendar' },
  'show':              { usage: 'show <id>', does: 'one node: an object as a pattern, or a measure, attribute, arrow or condition' },
  'dimensions':        { usage: 'dimensions <Fact> [<Fact> …]', does: 'what a fact is sliced by; for several, what they share' },
  'paths':             { usage: 'paths <Fact> <Object>', does: 'every path from a fact to an object' },
  'check':             { usage: 'check', does: 'the model\'s problems, if any' },
  'history':           { usage: 'history <id>', does: 'every change that touched a node' },
  'changes':           { usage: 'changes [--limit n]', does: 'the latest changes, applied or refused' },
  'export':            { usage: 'export <dir>', does: 'the model as files, for review' },
  'import':            { usage: 'import <dir>', does: 'build a model from exported files, one recorded operation per node' },
}

const READING = ['overview', 'show', 'dimensions', 'paths', 'check', 'history', 'changes', 'models']
const BUILDING = ['create-model', 'add-entity', 'add-calendar', 'add-fact', 'add-arrow', 'add-measure', 'add-attribute', 'add-condition', 'add-equation', 'set', 'rename', 'remove', 'promote-attribute', 'bind', 'add-program', 'set-setting', 'set-conversion']

/** The guide an agent is given to work with the tool: what a model is made of, how to change it, and every command —
 *  written from the command table itself, so it says what this version of the tool does. */
export function prompt(): { version: string; text: string } {
  const lines = (names: string[]) => names.map((c) => `  ${COMMANDS[c].usage} — ${COMMANDS[c].does}`).join('\n')
  const text = `# semantic-graph

The model questions are answered from. Read and change it only with this tool; each change is checked and recorded.

- Entity: a thing with identity; members, names, attributes, arrows to other entities.
- Attribute: a value an entity or fact carries (text, date, number, flag); never added up.
- Calendar: computed time levels.
- Fact: recorded events at a grain (its grain arrows); carries measures.
- Measure: a number on a fact — unit; flow, stock or value per unit; aggregate; currency for money.
- Arrow: grain, belongs, as-of, version, rollup or self; partial when it may be empty.
- Condition: named filters on one object, kept to by name.
- Dimension: an entity, attribute or calendar level a fact reaches; how its measures are sliced.

Read before adding; one idea is one node, another word for it a synonym. Ids: Object, Owner.name, condition:<name>.
Give each change --reason and --from. A refusal says what to change.

Reading
${lines(READING)}

Building
${lines(BUILDING)}

Moving
${lines(['export', 'import'])}

All commands: --db --model --json. Changes: --by --reason --from --dry-run.
`
  return { version: createHash('sha256').update(text).digest('hex').slice(0, 12), text }
}

function parse(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const args: string[] = [], flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2), next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else { flags[key] = next; i++ }
    } else args.push(a)
  }
  return { command: args.shift() ?? '', args, flags }
}

const text = (v: string | true | undefined) => (typeof v === 'string' ? (v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v) : undefined)
const list = (v: string | true | undefined) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined)
const json = (v: string | true | undefined, what: string) => {
  const t = text(v)
  if (t === undefined) return undefined
  try { return JSON.parse(t) } catch { throw new Error(`${what} is JSON, e.g. ${what === '--where' ? '[{"attribute":"status","in":["open"]}]' : '{"a":"column"}'}`) }
}
const pairs = (v: string | true | undefined) => {
  const t = text(v)
  if (t === undefined) return undefined
  if (t.trim().startsWith('{')) return JSON.parse(t)
  return Object.fromEntries(t.split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2))
}
const valueOf = (v: string) => { try { return JSON.parse(v) } catch { return v } }

export async function run(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { command, args, flags } = parse(argv)
  const say = (x: unknown) => out(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
  if (!command || command === 'help' || (flags.help && !COMMANDS[command])) {
    const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
    say(['semantic-graph <command> [arguments] [--flags]', '', ...Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(width)}  ${d.does}`), '',
      'every command: --db <file> --model <name> --json; every change: --by <who> --reason <why> --from <source> --dry-run', 'semantic-graph <command> --help for its arguments'].join('\n'))
    return 0
  }
  const spec = COMMANDS[command]
  if (!spec) { say(`no command "${command}" — semantic-graph help lists them`); return 1 }
  if (flags.help) { say(`semantic-graph ${spec.usage}\n  ${spec.does}`); return 0 }

  if (command === 'prompt') { const p = prompt(); say(flags.json ? p : `${p.text}\n<!-- semantic-graph prompt ${p.version} -->`); return 0 }
  const dbFile = text(flags.db) ?? process.env.SEMANTIC_GRAPH_DB ?? (process.env.ENGINE_PROJECT_DIR ? join(process.env.ENGINE_PROJECT_DIR, 'db', 'semantic-graph.sqlite') : undefined)
  if (!dbFile) { say('say which store: --db <file>, SEMANTIC_GRAPH_DB, or ENGINE_PROJECT_DIR for a project'); return 1 }
  const store = new ModelStore(dbFile)
  const model = text(flags.model) ?? process.env.SEMANTIC_MODEL ?? 'model'
  const ctx = { by: text(flags.by) ?? process.env.SEMANTIC_GRAPH_BY ?? process.env.USER ?? 'someone', reason: text(flags.reason), from: text(flags.from), dryRun: flags['dry-run'] === true }
  const need = (n: number) => { if (args.length < n) throw new Error(`usage: semantic-graph ${spec.usage}`) }
  const unset = flags.unset === true

  const change = (op: Operation) => {
    const r = store.apply(model, op, ctx)
    if (flags.json) { say(r.ok ? { ok: true, change: r.change, notes: r.notes } : r); return r.ok ? 0 : 2 }
    if (!r.ok) { say(`refused: ${r.reason}`); return 2 }
    say(`${ctx.dryRun ? 'would apply' : `applied (change ${r.change})`}: ${op.op} ${'id' in op ? op.id : 'name' in op ? op.name : 'object' in op ? op.object : 'key' in op ? op.key : ''}`.trim())
    for (const n of r.notes) say(`note: ${n}`)
    return 0
  }

  try {
    switch (command) {
      case 'models': say(flags.json ? store.models() : store.models().join('\n') || 'no models'); return 0
      case 'create-model': { need(1); const r = store.createModel(args[0], ctx); say(r.ok ? `created the model "${args[0]}"` : `refused: ${r.reason}`); return r.ok ? 0 : 2 }
      case 'add-entity': need(1); return change({ op: 'add-entity', name: args[0], description: text(flags.description), synonyms: list(flags.synonyms), members: pairs(flags.members), names: pairs(flags.names), history: text(flags.history) as 'current' | undefined })
      case 'add-calendar': need(1); return change({ op: 'add-calendar', name: args[0], level: text(flags.level), fiscal: json(flags.fiscal, '--fiscal'), periods: json(flags.periods, '--periods'), description: text(flags.description), synonyms: list(flags.synonyms) })
      case 'add-fact': need(1); return change({ op: 'add-fact', name: args[0], description: text(flags.description), synonyms: list(flags.synonyms), history: text(flags.history) as 'current' | undefined })
      case 'add-arrow': need(2); return change({ op: 'add-arrow', id: args[0], to: args[1], kind: text(flags.kind) as any, partial: flags.partial === true, synonyms: list(flags.synonyms) })
      case 'add-measure': need(1); return change({
        op: 'add-measure', id: args[0], unit: text(flags.unit)!, kind: text(flags.kind) as any, aggregate: text(flags.aggregate) as any, description: text(flags.description),
        currency: flags['currency-attribute'] ? { attribute: text(flags['currency-attribute'])! } : text(flags.currency)?.split('.'),
        of: text(flags.of), weight: text(flags.weight), versions: text(flags.versions), overTime: text(flags['over-time']) as any, synonyms: list(flags.synonyms),
      })
      case 'add-attribute': need(1); return change({ op: 'add-attribute', id: args[0], type: text(flags.type) as any, members: list(flags.members), synonyms: list(flags.synonyms), description: text(flags.description) })
      case 'add-condition': need(1); return change({ op: 'add-condition', name: args[0], on: text(flags.on)!, where: json(flags.where, '--where') ?? [], description: text(flags.description), synonyms: list(flags.synonyms) })
      case 'add-equation': need(3); return change({ op: 'add-equation', on: args[0], paths: [args[1].split('.'), args[2].split('.')] })
      case 'set': need(unset ? 2 : 3); return change({ op: 'set', id: args[0], property: args[1], value: unset ? null : valueOf(args.slice(2).join(' ')) })
      case 'rename': need(2); return change({ op: 'rename', id: args[0], to: args.slice(1).join(' ') })
      case 'remove': need(1); return change({ op: 'remove', id: args[0] })
      case 'promote-attribute': need(2); return change({ op: 'promote-attribute', id: args[0], entity: args[1] })
      case 'bind': {
        need(1)
        const binding: any = Object.fromEntries(Object.entries({
          source: text(flags.source), sql: text(flags.sql), program: text(flags.program), key: text(flags.key), label: text(flags.label), time: text(flags.time), timeZone: text(flags['time-zone']),
          arrows: json(flags.arrows, '--arrows') ?? {}, attributes: json(flags.attributes, '--attributes'), measures: json(flags.measures, '--measures'), history: json(flags.history, '--history'), params: json(flags.params, '--params'),
        }).filter(([, v]) => v !== undefined))
        return change({ op: 'bind', object: args[0], binding })
      }
      case 'add-program': need(1); return change({ op: 'add-program', name: args[0], program: { produces: text(flags.produces)!, reads: { sources: list(flags.sources) ?? [], objects: list(flags.objects) ?? [] }, body: text(flags.code) ?? '', ...(flags.description ? { description: text(flags.description) } : {}) } })
      case 'set-setting': need(unset ? 1 : 2); return change({ op: 'set-setting', key: args[0], value: unset ? null : valueOf(args.slice(1).join(' ')) })
      case 'set-conversion': return change({ op: 'set-conversion', conversion: unset ? undefined : { fact: text(flags.fact)!, from: text(flags.from)!, to: text(flags.to)!, day: text(flags.day)!, rate: text(flags.rate)!, at: (text(flags.at) ?? 'end') as 'row' | 'end' } })

      case 'overview': { const s = store.state(model).schema; say(flags.json ? catalog(s) : catalogText(s)); return 0 }
      case 'show': {
        need(1)
        const st = store.state(model), s = st.schema, id = args[0]
        if (s.objects[id]) { say(flags.json ? { ...node(s, id), binding: st.sources.facts[id] ?? st.sources.entities[id] ?? null } : nodeText(s, id)); return 0 }
        if (id.startsWith('condition:')) { say(s.conditions?.[id.slice(10)] ?? `there is no condition "${id.slice(10)}"`); return 0 }
        const [owner, name] = [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)]
        const o = s.objects[owner]
        const found = o?.measures?.[name] ? { measure: id, ...o.measures[name] } : o?.attributes?.[name] ? { attribute: id, ...o.attributes[name] } : o?.arrows?.[name] !== undefined ? { arrow: id, ...(typeof o.arrows[name] === 'string' ? { to: o.arrows[name] } : o.arrows[name] as object) } : undefined
        say(found ?? `there is no "${id}" in the model`)
        return found ? 0 : 1
      }
      case 'dimensions': { need(1); const s = store.state(model).schema; say(flags.json ? (args.length === 1 ? dimensions(s, args[0]) : conformedDimensions(s, args)) : dimensionsText(s, args)); return 0 }
      case 'paths': { need(2); const s = store.state(model).schema; say(flags.json ? paths(s, args[0], args[1]) : pathsText(s, args[0], args[1])); return 0 }
      case 'check': {
        const st = store.state(model)
        const problems = [...schemaProblems(st.schema), ...sourcesProblems(st.schema, st.sources).map((p) => `binding: ${p}`)]
        say(flags.json ? problems : problems.length ? problems.join('\n') : 'no problems')
        return problems.length ? 2 : 0
      }
      case 'history': case 'changes': {
        if (command === 'history') need(1)
        const rows = store.changes(model, { id: command === 'history' ? args[0] : undefined, limit: Number(text(flags.limit) ?? 50) })
        if (flags.json) { say(rows); return 0 }
        say(rows.map((c) => `${c.id}  ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}  ${c.applied ? '' : 'REFUSED '}${c.op} ${c.target ?? ''}  by ${c.by}${c.reason ? ` — ${c.reason}` : ''}${c.from ? ` (from ${c.from})` : ''}${c.refusal ? `\n      ${c.refusal}` : ''}`).join('\n') || 'no changes')
        return 0
      }
      case 'export': {
        need(1)
        const e = store.export(model), dir = args[0]
        mkdirSync(join(dir, 'programs'), { recursive: true })
        writeFileSync(join(dir, 'schema.json'), JSON.stringify(e.schema, null, 2) + '\n')
        writeFileSync(join(dir, 'sources.json'), JSON.stringify(e.sources, null, 2) + '\n')
        writeFileSync(join(dir, 'settings.json'), JSON.stringify(e.settings, null, 2) + '\n')
        for (const [name, p] of Object.entries(e.programs)) {
          mkdirSync(join(dir, 'programs', name), { recursive: true })
          const { body, ...def } = p
          writeFileSync(join(dir, 'programs', name, 'program.json'), JSON.stringify(def, null, 2) + '\n')
          writeFileSync(join(dir, 'programs', name, 'program.mjs'), body)
        }
        say(`exported the model "${model}" to ${dir}`)
        return 0
      }
      case 'import': {
        need(1)
        const dir = args[0]
        const read = (f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : undefined)
        const programs = existsSync(join(dir, 'programs')) ? Object.fromEntries(readdirSync(join(dir, 'programs')).filter((n) => existsSync(join(dir, 'programs', n, 'program.json')))
          .map((n) => [n, { ...JSON.parse(readFileSync(join(dir, 'programs', n, 'program.json'), 'utf8')), body: readFileSync(join(dir, 'programs', n, 'program.mjs'), 'utf8') }])) : {}
        const files = { schema: read('schema.json'), sources: read('sources.json'), settings: read('settings.json'), programs }
        if (!files.schema) throw new Error(`${dir} has no schema.json`)
        if (ctx.dryRun) { say(`would apply ${operationsFor(files).length} operations`); return 0 }
        const r = store.import(model, files, ctx)
        say(flags.json ? r : [`imported into "${model}": ${r.applied} operations applied, ${r.refused.length} refused`, ...r.refused.map((x) => `  refused ${x.op.op}: ${x.reason}`)].join('\n'))
        return r.refused.length ? 2 : 0
      }
    }
  } catch (e: any) {
    say(e?.message ?? String(e))
    return 1
  }
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await run(process.argv.slice(2)))
