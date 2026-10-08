// The agent's domain as the composition graph imports it (`sacli agent push <folder>` imports it, with the agent's
// programs and the agent itself). The domain is what the agent knows when asked in words: each concept is durable
// meaning — what a word means, how a figure is worked out from the tables, how they join, the traps — never a number or
// "today", which the agent computes at answer time. Its programs say in their doc.md what STATE they take, so a question
// in words can change STATE the same way a click does.
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
      { title: 'What a key is', form: 'text', text: 'A key is … (what it means, where it is kept, how it joins).' },
      { title: 'Traps', form: 'bullets', items: ['A column that looks like one thing and is another, and how to read it.'] },
    ],
  },
]
