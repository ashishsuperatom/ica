// THE DEFAULT CONCEPTS every project starts with (docs/platform-architecture.md "What a session shows"): how the engine
// works, said once — as ordinary concepts in the project's graph, editable like any other. These texts are only for
// BOOTSTRAPPING (a project whose graph lacks one gets it, attached to every domain) and for RESETTING one a person
// edited back to the default. What an agent reads is always the concept as it is in the graph — never these.

/** The data tools every domain gets when it is given the default concepts (it may change its list after). */
export const DEFAULT_TOOLS = ['sources', 'find-schema', 'get-schema', 'query']

type Atomic = { form: 'text'; title: string; text: string }
type Composed = { form: 'composed'; title: string; concepts: string[] }
export interface DefaultConcept { name: string; body: Atomic | Composed }

const lines = (...l: string[]) => l.join('\n')

/** ATOMIC: each says one thing, once — a project edits (or resets) one without touching the others. */
const ATOMS: DefaultConcept[] = [
  { name: 'answer/organisation', body: { form: 'text', title: 'The organisation', text:
    'It reports amounts in {{currency}}, keeps time in {{timeZone}}, and its financial year {{financialYear}}.' } },
  { name: 'answer/start', body: { form: 'text', title: 'How an answer starts', text:
    'The answer starts with a line `:::answer`.' } },
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
    '"columns": [{ "key", "label", "unit" }], "rows" }`. The answer\'s words say what it shows and what it means.') } },
  { name: 'answer/units', body: { form: 'text', title: 'What a column\'s numbers are', text: lines(
    'Each number column names its unit, and the reader sees it written the organisation\'s way: `money` (in its currency),',
    '`count`, `ratio` (0–1, shown as a percent), `percent` (0–100), `h`, `days`, `weeks`, `months`, `people`, `date`.',
    'The numbers in the file stay plain numbers.') } },
  { name: 'answer/amounts', body: { form: 'text', title: 'Amounts in the words', text: lines(
    'Amounts in the answer\'s words are rounded the way its tables show them: three significant figures, at the scale the',
    'organisation reads (thousands and millions, or lakh and crore), in its currency.') } },
  { name: 'answer/charts', body: { form: 'text', title: 'Charts', text: lines(
    'The same file is drawn as a chart by `:::bar <name>.json`, `:::line <name>.json` or `:::pie <name>.json`: its first',
    'column is what the chart runs along (a month, a branch), each number column a series.') } },
  { name: 'analysis/when', body: { form: 'text', title: 'Knowledge first', text:
    "Answer from this domain's knowledge and programs first. When they do not cover what is asked, find it in the data yourself." } },
  { name: 'analysis/tools', body: { form: 'text', title: 'The data tools', text: lines(
    '- `./sources` — the data sources, and how each one is queried',
    '- `./find-schema "<words>"` — where something lives',
    '- `./get-schema <SOURCE> <table>` — a table\'s fields',
    '- `./query "<SOURCE>" "<query>"` — read it, in that source\'s own language') } },
  { name: 'analysis/sources', body: { form: 'text', title: 'Where each figure comes from', text: lines(
    'Name the data each figure comes from in plain business words (purchase orders, contracts in force); the queries behind',
    'it are kept with the answer as its evidence. When the data does not hold what was asked, say so plainly.') } },
]

/** COMPOSITE (intermediate): the atoms combined, in order — what a domain attaches. */
const COMPOSITES: DefaultConcept[] = [
  { name: 'answering', body: { form: 'composed', title: 'How every answer is given', concepts: ['answer/organisation', 'answer/start', 'answer/period', 'answer/tables', 'answer/units', 'answer/amounts', 'answer/charts'] } },
  { name: 'own-analysis', body: { form: 'composed', title: "When this domain's knowledge does not cover a question", concepts: ['analysis/when', 'analysis/tools', 'analysis/sources'] } },
]

/** Every default, atoms before the composites that name them (the order they are put into a graph). */
export const DEFAULT_CONCEPTS: DefaultConcept[] = [...ATOMS, ...COMPOSITES]
/** What a domain attaches: the composites — `answering` first, `own-analysis` last. */
export const DEFAULT_ATTACHED = { first: 'answering', last: 'own-analysis' } as const

/** The default a concept was bootstrapped from, when it is one. */
export const defaultConcept = (name: string) => DEFAULT_CONCEPTS.find((c) => c.name === name) ?? null
