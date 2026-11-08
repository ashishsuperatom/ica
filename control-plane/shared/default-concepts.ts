// THE DEFAULT CONCEPTS every project starts with (docs/platform-architecture.md "What a session shows"): how the engine
// works, said once — as ordinary concepts in the project's graph, editable like any other. These texts are only for
// BOOTSTRAPPING (a project whose graph lacks one gets it, attached to every domain) and for RESETTING one a person
// edited back to the default. What an agent reads is always the concept as it is in the graph — never these.

/** The data tools every domain gets when it is given the default concepts (it may change its list after). */
export const DEFAULT_TOOLS = ['sources', 'find-schema', 'get-schema', 'query']

type Atomic = { form: 'text'; title: string; text: string }
type Composed = { form: 'composed'; title: string; concepts: string[]; /** An agent's role: its tools, by name. */ tools?: string[] }
export interface DefaultConcept { name: string; body: Atomic | Composed }

const lines = (...l: string[]) => l.join('\n')

/** ATOMIC: each says one thing, once — a project edits (or resets) one without touching the others. */
const ATOMS: DefaultConcept[] = [
  { name: 'answer/organisation', body: { form: 'text', title: 'The organisation', text:
    'It reports amounts in {{currency}}, keeps time in {{timeZone}}, and its financial year {{financialYear}}.' } },
  { name: 'answer/start', body: { form: 'text', title: 'How an answer starts', text:
    'The answer starts with a line `:::answer`.' } },
  { name: 'answer/order', body: { form: 'text', title: 'Words first', text: lines(
    'The words come first: the answer itself, in a sentence or two of plain text; then the tables and charts that support it.',
    'Bold marks only a key figure or a key term — never a whole sentence or paragraph.') } },
  { name: 'answer/shape', body: { form: 'text', title: 'Easy to read', text: lines(
    'Short paragraphs, two or three sentences each — never a long paragraph. An answer with more than one part gives each part',
    'a short heading (`### …`) with plain text under it. The data and the calculation stand apart from the words that explain',
    'them: figures go in a table (or a short list of figures), and the words say what they mean without repeating every',
    'number. Things that stand side by side are a list.') } },
  { name: 'answer/as-known', body: { form: 'text', title: 'Shown as it is known', text:
    'A way of showing that the intent\'s knowledge already holds is applied without remarking on it.' } },
  { name: 'answer/period', body: { form: 'text', title: 'The time an answer covers', text: lines(
    'The next line says it: `:::period <from> – <to> · <what kind>`, each end as precise as the data counts time (a date, or',
    'a date and time).',
    '- A span: `:::period <from> – <to> · <how much of it: complete weeks, months, hours…>`',
    '- A moment, for data that holds only its current state: `:::period As of <when it was read> · the state now`',
    '- All the data: `:::period All data · <the earliest in the data> – <the latest in the data>`',
    '- A forecast: `:::period <from> – <to> · forecast`',
    '- A comparison: one line per period, in the order compared.',
    '- A period still running ends `· to date`.') } },
  { name: 'answer/tables', body: { form: 'text', title: 'Tables', text: lines(
    'Any structured data the answer shows is written by a program you run: it reads the data (from one source or several),',
    'combines and shapes it, and writes the result to a file that the line `:::table <name>.json` shows — `{ "title",',
    '"columns": [{ "key", "label", "unit" }], "rows" }`. The answer\'s words say what it shows and what it means.',
    'A table has the columns a reader needs (an id only when it is asked for); a total row is named Total.') } },
  { name: 'answer/units', body: { form: 'text', title: 'What a column\'s numbers are', text: lines(
    'Each number column names its unit, and the reader sees it written the organisation\'s way: `money` (in its currency),',
    '`count`, `ratio` (0–1, shown as a percent), `percent` (0–100), `h`, `days`, `weeks`, `months`, `people`, `date`.',
    'The numbers in the file stay plain numbers. Money stays in the currency\'s own units; to show it at one scale a column',
    'says `"scale": "lakh"` (or `thousand`, `million`, `crore`) — the numbers are never divided for it.') } },
  { name: 'answer/amounts', body: { form: 'text', title: 'Amounts in the words', text: lines(
    'Amounts in the answer\'s words are rounded the way its tables show them: three significant figures, at the scale the',
    'organisation reads (thousands and millions, or lakh and crore), in its currency.') } },
  { name: 'answer/charts', body: { form: 'text', title: 'Charts', text: lines(
    'The same file is drawn as a chart by `:::bar <name>.json`, `:::line <name>.json` or `:::pie <name>.json`: its first',
    'column is what the chart runs along (a month, a branch), each number column a series. A chart shows one measure in one',
    'unit; the file\'s `"description"` is its caption — one line on what it shows.',
    'When these cannot say it: `:::echarts <name>.json` is an ECharts option of your own, drawn as written; `:::html',
    '<name>.html` is HTML of your own, shown as written.') } },
  { name: 'analysis/when', body: { form: 'text', title: 'Knowledge first', text:
    "Answer from this domain's knowledge and programs first. When they do not cover what is asked, find it in the data yourself." } },
  { name: 'analysis/tools', body: { form: 'text', title: 'The data tools', text: lines(
    '- `./sources` — the data sources, and how each one is queried',
    '- `./find-schema "<words>"` — where something lives',
    '- `./get-schema <SOURCE> <table>` — a table\'s fields',
    '- `./query "<SOURCE>" "<query>"` — read it, in that source\'s own language',
    '- `./find-concept "<words>"` — the project\'s knowledge beyond your own concepts, when they do not cover what you need') } },
  { name: 'analysis/sources', body: { form: 'text', title: 'Where each figure comes from', text: lines(
    'Name the data each figure comes from in plain business words (purchase orders, contracts in force); the queries behind',
    'it are kept with the answer as its evidence. When the data does not hold what was asked, say so plainly.') } },
  { name: 'agents/composer', body: { form: 'text', title: 'The composer', text: lines(
    "You are a session's composer: every message the person sends comes to you first. You answer the questions whose intent",
    'is known here, from that intent\'s knowledge.',
    'A question that is a new intent — or the intent you are in, in a situation its knowledge does not cover — is answered by',
    "the session's analyst: hand it the person's question with",
    '  ./send-to-agent analyst current-question',
    'and your turn is over: the analyst answers the person.',
    'With a matched intent, answer it yourself with its way and your tools. Then set what you found beside what the intent',
    'has met (its experience: the situations it has seen and what their figures were): within one, or near it, the answer',
    'is yours to give; far from anything it has met, say what is different and hand the question to the analyst.') } },
  { name: 'agents/analyst', body: { form: 'text', title: 'The analyst', text: lines(
    "You are a session's analyst. A session is one person's conversation with their organisation's data: every answer given",
    'in it (../ANSWER_HISTORY.jsonl), its STATE — what its programs show, as JSON (../STATE.json) — and the programs it runs.',
    "The session's composer answers the questions whose intent is already known; the questions that are new here come to",
    'you, each as the person asked it. You read the data with the tools in this folder and answer in markdown; the tables',
    'and charts your answer names are files you write here.') } },
  { name: 'experience/surprises', body: { form: 'text', title: 'Known surprises', text: lines(
    'What an answer can meet that is unlike what its intent has met — the kinds known so far. Name a surprise by one of',
    'these when it fits; when none fits, it is an unknown one: name it and say it in a line.',
    '- usual: within what was met before (no surprise)',
    '- drift: moving steadily one way',
    '- cycle: rises and falls with the calendar or another repeating context',
    '- subgroup: one part of the scope has a normal of its own',
    '- scale: much bigger or smaller, but in the same proportions',
    '- concentrated: a few items carry most of the result',
    '- empty: nothing qualifies, and that is the true answer',
    '- threshold: a small move crossed a line that changes the conclusion',
    '- combined: two known kinds at once',
    '- one-off: a single event distorts this run',
    '- new-normal: settled at a new level',
    '- rule-change: how something is defined or counted changed from a date',
    '- incomplete: the period or scope is only partly there',
    '- stale: the source has not been refreshed',
    '- data-quality: impossible values, duplicates or wrong units',
    '- source-change: new categories, statuses or fields',
    '- sources-disagree',
    '- restricted: the person\'s access hides part of it — right for them, partial',
    '- method-branch: it needs a different calculation',
    '- ambiguous: the question reads more than one way',
    '- no-baseline: nothing earlier to compare with',
    '- too-few: not enough met yet to know what is usual') } },
  { name: 'intent/decide', body: { form: 'text', title: 'Which intent a message is', text: lines(
    'First, before any other tool, spell the message out as a question that stands alone: whatever it leans on from the',
    'conversation said in it (what "these", "that vendor" or "by plant" refer to), nothing added that was not asked. Then',
    '  ./find-intent "<the question, spelled out>"',
    'gives the intents it may be, with what is known of each. Decide by meaning, and say it on a line of its own:',
    ':::node same — it continues the intent you are in: answer it from that intent\'s knowledge',
    ':::node <id> — it is exactly one of the candidates: answer it from that candidate\'s knowledge',
    ':::node new — it is none of them: send it to the analyst',
    ':::node none — it is not a request (a greeting, a thank-you): answer it') } },
  { name: 'agents/workbench', body: { form: 'text', title: 'The workbench', text: lines(
    'You are the workbench: someone who develops this project works with you hands-on, in a session that lasts — they bring',
    'a piece of work, you do it with the tools in this folder, and they come back to it. Say what you are doing as you go.',
    'Your answer starts at a line `:::answer` and is shown the way every answer is (below).') } },
  { name: 'intent/match', body: { form: 'text', title: 'What a match is', text: lines(
    'A message matches an intent when it asks for exactly the same thing — the same meaning, not the same words: the same',
    'thing to find out or to do, possibly for another value (another period, item, person or amount). One that asks for',
    'more, for less, or for something near it does not match. When unsure, it is new: a new intent costs a little, a wrong',
    'match gives the wrong answer.') } },
  { name: 'intent/same', body: { form: 'text', title: 'Staying in an intent', text: lines(
    'A message about the answer just given — shown another way, a field added or left out, a total at the bottom, a',
    'correction, its detail — continues the intent it answered. A message that asks for something else is another intent,',
    'even about the same things.') } },
  { name: 'intent/new', body: { form: 'text', title: 'A new kind of question', text: lines(
    'The questions you are given are new here: no one has answered their kind before. Answer each one fully from the data.',
    'How you found it — what you read, the steps, the traps — becomes the way questions of its kind are answered from now',
    'on, so work it out properly, not quickly.') } },
]

/** COMPOSITE (intermediate): the atoms combined, in order — what a domain attaches. */
const COMPOSITES: DefaultConcept[] = [
  { name: 'answering', body: { form: 'composed', title: 'How every answer is given', concepts: ['answer/organisation', 'answer/start', 'answer/period', 'answer/order', 'answer/shape', 'answer/as-known', 'answer/tables', 'answer/units', 'answer/amounts', 'answer/charts'] } },
  // Each of a session's two agents is given its domain's concepts and its own role (app-seam.ts).
  // Each role names the tools its agent is given — the engine gives it those and answers it only for those. The composer
  // reaches an intent and uses it (anything uncertain goes to the analyst); the analyst explores and builds. The data-source
  // index (sources, find-schema, get-schema) is every data agent's: what tables and columns there are, beneath the concepts.
  { name: 'role/composer', body: { form: 'composed', title: "The session's composer", concepts: ['agents/composer', 'intent/decide', 'intent/match', 'intent/same', 'experience/surprises'], tools: ['find-intent', 'send-to-agent', 'sources', 'find-schema', 'get-schema', 'query', 'experience'] } },
  // The workbench is given what it knows once, at its session's start — no intent, no concept search: what is there is there.
  { name: 'role/workbench', body: { form: 'composed', title: 'The workbench', concepts: ['agents/workbench', 'analysis/sources'], tools: ['sources', 'find-schema', 'get-schema', 'query'] } },
  { name: 'role/analyst', body: { form: 'composed', title: "The session's analyst", concepts: ['agents/analyst', 'intent/new', 'analysis/when', 'analysis/tools', 'analysis/sources'], tools: ['sources', 'find-schema', 'get-schema', 'query', 'find-concept', 'experience'] } },
  { name: 'own-analysis', body: { form: 'composed', title: "When this domain's knowledge does not cover a question", concepts: ['analysis/when', 'analysis/tools', 'analysis/sources'] } },
]

/** Every default, atoms before the composites that name them (the order they are put into a graph). */
export const DEFAULT_CONCEPTS: DefaultConcept[] = [...ATOMS, ...COMPOSITES]
/** What a domain attaches: `answering` (how every answer is given). Exploring the data (`own-analysis`) is the analyst's,
 *  in its role — never a domain's. */
export const DEFAULT_ATTACHED = { first: 'answering' } as const

/** The default a concept was bootstrapped from, when it is one. */
export const defaultConcept = (name: string) => DEFAULT_CONCEPTS.find((c) => c.name === name) ?? null
