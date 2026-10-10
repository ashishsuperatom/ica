// The agent's domain as the composition graph imports it (`sacli agent push <folder>` imports it, with the agent's
// programs and the agent itself). How concepts are written: `composition-graph guide`; check before importing with
// `composition-graph check knowledge/index.mts`. A concept is what one kind of question needs, in only the sections
// it needs (entity map, definitions, calculation, rules, method, examples); each thing is said in one concept and the
// others name it in `uses`. No instance — a name, an id, a number, "today" — outside the examples. Its programs say in
// their doc.md what STATE they take, so a question in words can change STATE the same way a click does.
import type { ConceptBody } from '@superatom/composition-graph'

type Concept = ConceptBody & { name?: string }

export const settings: { name: string; value: unknown; description: string }[] = []

export const domains: { name: string; description: string; intents: string[]; capabilities: string[]; concepts: Concept[]; files: string[]; tools: string[]; settings: string[] }[] = [
  {
    name: 'example',
    description: 'What the agent answers, in one line.',
    intents: ['the questions it answers, in the words people use'],
    capabilities: [],
    tools: ['sources', 'find-schema', 'get-schema', 'query'],
    files: [],
    settings: [],
    concepts: [
      {
        name: 'what-the-entities-are-and-how-they-join', title: 'The entities and how they join', form: 'sections',
        sections: [{ name: 'entity map', text: 'thing ──1:n── line ──n:1── other thing\n  key thing_id        key other_id' }],
      },
      {
        name: 'how-the-main-figure-is-worked-out', title: 'How the main figure is worked out', form: 'sections',
        uses: ['what-the-entities-are-and-how-they-join'],
        sections: [
          { name: 'definitions', items: ['figure = what it means, generically, or its formula'] },
          { name: 'calculation', text: 'line → thing\nfilter what counts · group by what it is shown by · measure sum(value)' },
          { name: 'rules', items: ['A column that looks like one thing and is another, and how to read it.'] },
        ],
      },
    ],
  },
]
