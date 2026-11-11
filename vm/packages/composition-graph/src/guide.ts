// How a concept is written — the rules every author follows, people and agents alike
// (docs/composition-graph.md, "What a concept holds and what a domain holds"). `composition-graph guide` prints it;
// verify.ts checks what can be checked without reading for meaning.

export const CONCEPT_GUIDE = `# Writing concepts

A concept is what one kind of question — or one kind of need, such as how something is shown — requires. It takes
only the sections it needs (form "sections"), and some concepts are plain words:
- entity map — the entities it touches, how they relate, by which key: an ASCII graph.
- definitions — what its terms mean, generically: a sentence each, or a formula.
- calculation — how its figures are worked out: a pseudo-query (from, join, filter, group, measure) or a formula.
  The logic, not a full runnable query — a full query is copied instead of understood.
- rules — what holds generally: traps, exclusions, identities.
- method — how to answer its question: steps.
- examples — worked examples. The only place an instance (a name, an id, a date, a value from the data) appears.

A question reaches the concepts it stands on through its intent (the intent graph): an intent's way names them, and an
agent finds more with find-concept. A domain is only an ICA's first prompt — the platform's (composer-domain,
analyst-domain, …) — never where a business area's knowledge goes.

- Atomic: each thing is said in exactly one concept. What two concepts need is its own concept, named, listed in
  each one's "uses" — never copied. When something changes, there is one
  place to change it.
- Search before writing: what is already said is used, not said again.
- Generic, never instances: say what is true of the data's shape, not what the data holds today.
- The most exact language: a query or a program over a formula, a formula over a sentence — words when they say more.
`
