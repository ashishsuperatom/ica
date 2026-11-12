// THE TOOL TREE (docs/programs-design.md "Tools and programs: one tree, one inspect"): every tool the platform gives an
// ICA is one CARD at its place in the tree — tools.<area>.<tool> — read the same way everywhere: by `./inspect <path>`,
// and in a concept as {{<path>}}, composed into the ICA's prompt. A path may end in `*` (the node and its children) or
// `**` (its whole subtree). An ICA may run exactly the tools under the paths its domain's concepts reference (and
// ./inspect, always): nothing about a tool is written by hand into a concept, and no list of tools is kept beside it.
// Each tool keeps its own command; the card only says what it is and how to use it. The engine runs each one under the
// command its card names (a check fails the build when a card has no handler or a handler no card).

/** One node of the tree: an AREA (no command — what its tools are for; its children are listed under it) or a TOOL. */
export interface ToolCard {
  /** Its place in the tree: tools.<area> or tools.<area>.<tool>. */
  name: string
  /** One line: what it is for — all a listing of its parent shows besides its input. */
  summary: string
  /** A tool's command (`./<command>` in the ICA's folder); an area has none. */
  command?: string
  /** How it is run, as written in the folder. */
  input?: string
  /** What it gives back. */
  output?: string
  /** The sections, always these (a tool has each; an area only `when`). */
  when: string
  how?: string[]
  example?: string
  traps?: string[]
}

const area = (name: string, summary: string, when: string): ToolCard => ({ name, summary, when })

export const TOOL_CARDS: ToolCard[] = [
  { name: 'tools.inspect', command: 'inspect', summary: 'Read what you can use: the tools, and how each is used',
    input: "./inspect [<path>|'<path>.*'|'<path>.**']", output: 'the node, and its children one line each — or, with * and **, each of them whole',
    when: 'To find a tool you were not told of, or to read one fully before using it.',
    how: ['./inspect alone gives the top of the tree, one line each.', '<path> gives that node and lists its children; <path>.* gives each child whole; <path>.** the whole subtree.'],
    example: "./inspect tools.data.query · ./inspect 'tools.intent.*'",
    traps: ['Quote a path with * so the shell does not expand it.'] },

  area('tools.intent', 'The intents: what kind of question a message is, and how it is answered', 'Every message: find the intent it is, and answer from that intent\'s knowledge.'),
  { name: 'tools.intent.find-intent', command: 'find-intent', summary: 'The intents a question may be, found by its words',
    input: './find-intent "<the question, spelled out in full>"', output: 'the candidates, each with what it is',
    when: 'First, for every message, before any other tool.',
    how: ['Spell the message out as a question that stands alone: what it leans on from the conversation said in it, nothing added.', 'Decide among the candidates by meaning, not by words.'],
    example: './find-intent "revenue by region for last month"',
    traps: ['The words you give are kept as what the question was understood to be: spell it out whole.'] },
  { name: 'tools.intent.get-intent', command: 'get-intent', summary: 'Read one intent\'s knowledge: its way, what it stands on, what it has met',
    input: './get-intent <id>', output: 'the intent\'s knowledge',
    when: 'To see what a candidate, or the intent you are in, is about before deciding.',
    how: ['Read it, then decide by meaning whether the message asks for exactly the same thing.'],
    example: './get-intent in-3kq9x2m1',
    traps: ['Reading an intent does not choose it: only ./choose-intent does.'] },
  { name: 'tools.intent.choose-intent', command: 'choose-intent', summary: 'Give your answer at an intent: the one the message is',
    input: './choose-intent <id>', output: 'the intent your answer is given at',
    when: 'The message continues the intent you are in, or asks for exactly the same thing as one of the candidates.',
    how: ['Choose it, then answer from its way.', 'Choose none when the message is none of them: it is a new intent.'],
    example: './choose-intent in-3kq9x2m1',
    traps: ['The intent you choose last is the one your answer is given at.', 'Near is not the same: another measure, breakdown or subject is another intent.'] },
  { name: 'tools.intent.experience', command: 'experience', summary: 'What an intent has met: its signals, scenarios and cases',
    input: './experience <intent id> [--recent N]', output: 'JSON: signals, scenarios with their expectations, cases',
    when: 'To set an answer beside what the intent has met before, or to compute over its cases.',
    how: ['Read it after get-intent; compare this answer\'s figures with its scenarios\' expectations.'],
    example: './experience in-3kq9x2m1 --recent 20',
    traps: ['With few cases, expect little: an early surprise is not yet a new situation.'] },

  area('tools.data', 'The data sources: what they hold, and reading them', 'Whenever an answer needs the data.'),
  { name: 'tools.data.sources', command: 'sources', summary: 'Every data source, with its kind and dialect',
    input: './sources', output: 'JSON: each source\'s id, kind, dialect and what it is',
    when: 'Before writing a query: which source holds it, and in which language it is read.',
    how: ['Read the dialect: each source is queried in its own language.'],
    example: './sources',
    traps: ['A source marked not reachable cannot be read now: say so rather than answer without it.'] },
  { name: 'tools.data.find-schema', command: 'find-schema', summary: 'Where something lives: tables and fields, by name, type or description',
    input: './find-schema "<words>" [--source <SOURCE>] [--full]', output: 'the sources the hits belong to, then the fields and tables',
    when: 'You know what you need, not where it is.',
    how: ['Search by the business words; narrow to a source with --source.'],
    example: './find-schema "order date" --source <SOURCE>',
    traps: ['A table your access hides is not shown: what is not found may be hidden, not absent.'] },
  { name: 'tools.data.get-schema', command: 'get-schema', summary: 'A source\'s tables, or a table\'s fields',
    input: './get-schema [<SOURCE>] [<table>]', output: 'JSON: every source; a source\'s tables with row and field counts; or a table\'s fields with type, key, references and description',
    when: 'Before querying a table: its fields, keys and how it joins.',
    how: ['Without arguments, every source; with a source, its tables; with a table, its fields.'],
    example: './get-schema <SOURCE> <table>',
    traps: [] },
  { name: 'tools.data.query', command: 'query', summary: 'Read a source, in its own language',
    input: './query "<SOURCE>" "<query in the source\'s dialect>"', output: 'JSON rows',
    when: 'To read the data an answer stands on.',
    how: ['Write the query in the source\'s dialect (./sources says it).', 'Read what you need: totals in the query, not by reading every row.'],
    example: './query "<SOURCE>" "SELECT region, COUNT(*) AS orders FROM orders GROUP BY region"',
    traps: ['A note that the result reached its row limit means it is not whole: total in the query instead.', 'Every query is recorded with your answer, as its evidence.'] },

  area('tools.concept', 'The project\'s knowledge beyond what you were given', 'Your own concepts do not cover what is asked.'),
  { name: 'tools.concept.find-concept', command: 'find-concept', summary: 'The project\'s concepts that best match some words, whole',
    input: './find-concept "<words>"', output: 'JSON: the best matching concepts, each whole',
    when: 'A definition, rule or join you need is not in what you were given.',
    how: ['Search by the business words; use what fits, say what you used.'],
    example: './find-concept "net revenue"',
    traps: [] },

  area('tools.agent', 'The session\'s other agents', 'A question is another agent\'s to answer.'),
  { name: 'tools.agent.send-to-agent', command: 'send-to-agent', summary: 'Hand the person\'s question to another of the session\'s agents',
    input: './send-to-agent <agent> current-question', output: 'that it was sent; your turn is over',
    when: 'Your role says the question is another agent\'s.',
    how: ['Send current-question: the engine hands over the person\'s question as they asked it.'],
    example: './send-to-agent analyst current-question',
    traps: ['After sending, write nothing more: the other agent answers the person.'] },

  area('tools.connection', 'The person\'s connections to the data sources', 'Someone needs to connect, or sign in to, a data source.'),
  { name: 'tools.connection.connections', command: 'connections', summary: 'What the person can connect, and what they have connected',
    input: './connections', output: 'JSON: the project\'s connections (for one read with each person\'s own account, whether they connected it) and the connectors it may use',
    when: 'Before asking someone to connect or sign in.',
    how: ['Find the connection the question needs, and whether this person has connected theirs.'],
    example: './connections',
    traps: ['It never shows a key or a secret, and you never ask for one.'] },
]

/** The tool or area at a path, or null. */
export const cardAt = (name: string) => TOOL_CARDS.find((c) => c.name === name) ?? null
/** A card by its command. */
export const cardOf = (command: string) => TOOL_CARDS.find((c) => c.command === command) ?? null
/** Every command there is. */
export const TOOL_COMMANDS: string[] = TOOL_CARDS.flatMap((c) => (c.command ? [c.command] : []))

const parentOf = (name: string) => name.slice(0, name.lastIndexOf('.'))
const childrenOf = (name: string, cards = TOOL_CARDS) => cards.filter((c) => parentOf(c.name) === name)
const under = (name: string, cards = TOOL_CARDS) => cards.filter((c) => c.name === name || c.name.startsWith(name + '.'))

/** A path as written — `tools.data`, `tools.data.*`, `tools.data.**` — or null when it is not one. */
export function parsePath(path: string): { name: string; depth: 'node' | 'children' | 'all' } | null {
  const m = /^(tools(?:\.[a-z][a-z0-9-]*)*)(\.\*\*|\.\*)?$/.exec(path.trim())
  if (!m) return null
  return { name: m[1]!, depth: m[2] === '.**' ? 'all' : m[2] === '.*' ? 'children' : 'node' }
}

/** A node in one line, as its parent lists it. */
const line = (c: ToolCard) => `- ${c.input ?? c.name} — ${c.summary}${c.command ? '' : ` (./inspect ${c.name})`}`
/** A node whole: a tool's card, or an area with its tools one line each. */
function whole(c: ToolCard, listChildren: boolean, cards: ToolCard[]): string {
  // An area is headed by what it is, in words — a path in a heading reads like a folder to go into.
  const out = [c.command ? `### ./${c.command} — ${c.summary}` : `### ${c.summary}`]
  if (c.input) out.push(`Run: ${c.input}`)
  if (c.output) out.push(`Gives: ${c.output}`)
  out.push(`When: ${c.when}`)
  if (c.how?.length) out.push(`How:\n${c.how.map((h) => `- ${h}`).join('\n')}`)
  if (c.example) out.push(`Example: ${c.example}`)
  if (c.traps?.length) out.push(`Traps:\n${c.traps.map((t) => `- ${t}`).join('\n')}`)
  const kids = childrenOf(c.name, cards)
  if (listChildren && kids.length) out.push(`${kids.map(line).join('\n')}\nEach in full: ./inspect '${c.name}.*'`)
  return out.join('\n')
}

/** What `./inspect <path>` prints, and what {{<path>}} is composed as: the same text. null when there is no such node. */
export function inspectTools(path = '', cards = TOOL_CARDS): string | null {
  if (!path.trim()) {
    const top = cards.filter((c) => c.name.split('.').length === 2)
    return `The tools (./inspect <path> for one):\n${top.map(line).join('\n')}`
  }
  const p = parsePath(path)
  const c = p ? cards.find((x) => x.name === p.name) : null
  if (!p || !c) return null
  if (p.depth === 'node') return whole(c, true, cards)
  const rest = p.depth === 'children' ? childrenOf(c.name, cards) : under(c.name, cards).filter((x) => x !== c)
  return [whole(c, false, cards), ...rest.map((x) => whole(x, x.command ? false : p.depth === 'children', cards))].join('\n\n')
}

/** The commands an ICA may run, from the paths its prompt references: every tool under each (a path grants its whole
 *  subtree — how much of it is shown is only how much is read at the start), and ./inspect always. */
export function reachOf(paths: string[], cards = TOOL_CARDS): string[] {
  const out = new Set<string>(['inspect'])
  for (const path of paths) { const p = parsePath(path); if (p) for (const c of under(p.name, cards)) if (c.command) out.add(c.command) }
  return [...out]
}

/** What is wrong with the tree, in sentences: every card at a place under an area that exists, a command for a tool and none
 *  for an area, its sections there, no name or command twice. */
export function checkCards(cards = TOOL_CARDS): string[] {
  const out: string[] = []
  const names = new Set<string>()
  for (const c of cards) {
    if (names.has(c.name)) out.push(`${c.name} is there twice`)
    names.add(c.name)
    if (!parsePath(c.name) || c.name === 'tools') out.push(`${c.name} is not a place in the tree (tools.<area>[.<tool>])`)
    const depth = c.name.split('.').length
    if (depth === 3 && !cards.some((x) => x.name === parentOf(c.name))) out.push(`${c.name}: there is no area ${parentOf(c.name)}`)
    if (!c.summary?.trim() || !c.when?.trim()) out.push(`${c.name} has a summary and a When`)
    const isArea = childrenOf(c.name, cards).length > 0
    if (isArea && c.command) out.push(`${c.name} is an area: it has no command`)
    if (!isArea && depth === 3 && !c.command) out.push(`${c.name} is a tool: it names its command`)
    if (c.command) {
      if (c.name.split('.').pop() !== c.command) out.push(`${c.name}: a tool's name ends in its command (${c.command})`)
      if (!c.input || !c.output || !c.how?.length || !c.example || !c.traps) out.push(`${c.name}: a tool has Run, Gives, When, How, Example and Traps`)
    }
  }
  const all = cards.flatMap((c) => (c.command ? [c.command] : []))
  const commands = all.filter((x, i, a) => a.indexOf(x) !== i)
  if (commands.length) out.push(`commands named twice: ${commands.join(', ')}`)
  return out
}
