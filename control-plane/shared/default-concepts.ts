// THE DEFAULT CONCEPTS every project starts with (docs/platform-architecture.md "What a session shows"): how the engine
// works, said once — as ordinary concepts in the project's graph, editable like any other. These texts are only for
// BOOTSTRAPPING (a project whose graph lacks one gets it, attached to every domain) and for RESETTING one a person
// edited back to the default. What an agent reads is always the concept as it is in the graph — never these.

/** The data tools every domain gets when it is given the default concepts (it may change its list after). */
export const DEFAULT_TOOLS = ['sources', 'find-schema', 'get-schema', 'query']

export interface DefaultConcept { name: string; body: { form: 'text'; title: string; text: string } }

export const DEFAULT_CONCEPTS: DefaultConcept[] = [
  {
    name: 'answering',
    body: { form: 'text', title: 'How every answer is given', text: [
      '- The organisation reports amounts in {{currency}}, keeps time in {{timeZone}}, and its financial year {{financialYear}}.',
      '- The answer starts with a line `:::answer`.',
      '- The next line says the time the answer covers: `:::period <from> – <to> · <what kind>`, each end as precise as the',
      '  data counts time (a date, or a date and time).',
      '  - A span: `:::period <from> – <to> · <how much of it: complete weeks, months, hours…>`',
      '  - A moment, for data that holds only its current state: `:::period As of <when it was read> · the state now`',
      '  - All the data: `:::period All data · <the earliest in the data> – <the latest in the data>`',
      '  - A forecast: `:::period <from> – <to> · forecast`',
      '  - A comparison: one line per period, in the order compared.',
      '  - A period still running ends `· to date`.',
      '- Any structured data the answer shows is written by a program you run: it reads the data (from one source or several),',
      '  combines and shapes it, and writes the result to a file that the line `:::table <name>.json` shows. The answer\'s words',
      '  say what it shows and what it means.',
      '- The same file is drawn as a chart by `:::bar <name>.json`, `:::line <name>.json` or `:::pie <name>.json`: its first',
      '  column is what the chart runs along (a month, a branch), each number column a series.',
    ].join('\n') },
  },
  {
    name: 'own-analysis',
    body: { form: 'text', title: "When this domain's knowledge does not cover a question", text: [
      "Answer from this domain's knowledge and programs first. When they do not cover what is asked, find it in the data yourself:",
      '- `./sources` — the data sources, and how each one is queried',
      '- `./find-schema "<words>"` — where something lives',
      '- `./get-schema <SOURCE> <table>` — a table\'s fields',
      '- `./query "<SOURCE>" "<query>"` — read it, in that source\'s own language',
      'Say which source and table each figure comes from. When the data does not hold what was asked, say so plainly.',
    ].join('\n') },
  },
]

/** The default a concept was bootstrapped from, when it is one. */
export const defaultConcept = (name: string) => DEFAULT_CONCEPTS.find((c) => c.name === name) ?? null
