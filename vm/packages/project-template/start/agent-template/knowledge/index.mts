// What the agent's questions stand on, as the composition graph imports it (`sacli agent push <folder>` imports it,
// with the agent's programs and the agent itself): CONCEPTS — the atomic knowledge base, each thing said once. A
// question reaches them through its intent (docs/intent-graph.md): an intent's way names the concepts it stands on, and
// the ICA finds more with find-concept. Nothing routes a question by them, and no ICA is told them all up front: an
// ICA's first prompt is its domain, the platform's (agent.json `domain`).
//
// How concepts are written: `composition-graph guide`; check before importing with `composition-graph check
// knowledge/index.mts`. A concept is what one kind of question needs, in only the sections it needs (entity map,
// definitions, calculation, rules, method, examples); each thing is said in one concept and the others name it in
// `uses`. No instance — a name, an id, a number, "today" — outside the examples. Meaning, rules, joins and traps: never
// numbers. The programs say in their doc.md what STATE they take, so a question in words can change STATE the same way
// a click does.
import type { ConceptBody } from '@superatom/composition-graph'

type Concept = ConceptBody & { name: string }

/** The organisation's decisions a program reads (a threshold, a floor), by name — each named in the reading program's
 *  manifest ("settings"). How it reads time, money and words is its configuration, never a setting. */
export const settings: { name: string; value: unknown; description: string }[] = []

export const concepts: Concept[] = [
  {
    name: 'example/entities-and-joins', title: 'The entities and how they join', form: 'sections',
    sections: [{ name: 'entity map', text: 'thing ──1:n── line ──n:1── other thing\n  key thing_id        key other_id' }],
  },
  {
    name: 'example/main-figure', title: 'How the main figure is worked out', form: 'sections',
    uses: ['example/entities-and-joins'],
    sections: [
      { name: 'definitions', items: ['figure = what it means, generically, or its formula'] },
      { name: 'calculation', text: 'line → thing\nfilter what counts · group by what it is shown by · measure sum(value)' },
      { name: 'rules', items: ['A column that looks like one thing and is another, and how to read it.'] },
    ],
  },
]
