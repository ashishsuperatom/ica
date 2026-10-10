// How a concept and a domain are written — the rules every author follows, people and agents alike
// (docs/composition-graph.md, "What a concept holds and what a domain holds"). `composition-graph guide` prints it;
// verify.ts checks what can be checked without reading for meaning.

export const CONCEPT_GUIDE = `# Writing concepts and domains

A concept is what one kind of question — or one kind of need, such as how something is shown — requires. It takes
only the sections it needs (form "sections"), and some concepts are plain words:
- entity map — the entities it touches, how they relate, by which key: an ASCII graph.
- definitions — what its terms mean, generically: a sentence each, or a formula.
- calculation — how its figures are worked out: a pseudo-query (from, join, filter, group, measure) or a formula.
  The logic, not a full runnable query — a full query is copied instead of understood.
- rules — what holds generally: traps, exclusions, identities.
- method — how to answer its question: steps.
- examples — worked examples. The only place an instance (a name, an id, a date, a value from the data) appears.

A domain has the same sections at its breadth — the entity map of its whole area, the definitions and rules its
concepts share — and its intents, tools, programs, settings and concepts.

- Atomic: each thing is said in exactly one concept. What two concepts need is its own concept, named, listed in
  each one's "uses" and composed into the domain beside them — never copied. When something changes, there is one
  place to change it.
- Search before writing: what is already said is used, not said again.
- Generic, never instances: say what is true of the data's shape, not what the data holds today.
- The most exact language: a query or a program over a formula, a formula over a sentence — words when they say more.
`
