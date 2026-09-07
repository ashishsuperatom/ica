# Stable Attractor Associative Memory for an Agent

## Goal

Build a domain-memory system for a coding/knowledge agent that learns from completed work across many independent sessions.

The same underlying agent may be cloned at a commit/discovery point to create a memory. Later sessions should be able to retrieve that experience when they enter a sufficiently similar situation.

The objective is NOT to encode deterministic programming knowledge or create a manually designed rule ontology.

The objective is to create a memory system whose useful behavior emerges through repeated experience:

- associate experiences with language-level phrases/cues
- retrieve memories by associative overlap
- avoid unnecessary specialization
- allow memories to remain conditional and contradictory
- learn stable attractors over time
- allow exploration rather than blindly reusing previous answers
- periodically reconcile the memory system using more expensive semantic/vector processing

## Core principle: specificity must be earned

A single experience containing a particular value does NOT establish that the value is causally relevant.

Example:

"Calculate Q3 revenue for major code 003 for Finance."

If the discovered solution is the same general revenue logic that would work for 001, 002, 007, Supply Chain, etc., the memory should remain general.

Do NOT automatically create a rule such as:

revenue + finance + 003 -> special rule

just because those cues appeared in one experience.

Specificity should emerge only when accumulated experience provides evidence that a cue or combination of cues actually distinguishes behavior.

The system should therefore prefer the most general stable explanation that remains consistent with observed experience, and specialize only when reuse produces evidence that the more general memory is insufficient.

## The state is not a rigid schema

Do not require a deterministic "applicable state", "claim", "observed context", or manually defined state object.

The useful state is represented as language.

At a meaningful completion point, clone the current agent. The clone is the SAME agent with the full conversation and trajectory available to it. Ask it to create a memory from the entire experience.

It should produce:

1. the experience/knowledge worth remembering
2. a collection of phrases, concepts, entities, conditions, and contextual cues that would help recognize a similar situation later

Example:

Memory:
"Finance revenue is recognized revenue and is sourced from fact_revenue_v2. The optimized query should be used for historical data because the original query is too slow."

Cues might include:

revenue
finance reporting
recognized revenue
P&L
fact_revenue_v2
historical revenue
slow revenue query
optimized revenue query

The clone should NOT be forced to include every detail from the conversation as a cue.

Its job is to describe the situation in language that will help associative retrieval.

## Important: memory creation itself requires memory retrieval

A new experience cannot always be interpreted in isolation.

Suppose experience 1 produced a memory containing:

revenue + 003 -> some observation

When experience 2 occurs, we cannot decide whether "003" matters without comparing experience 2 against the existing memory.

Therefore memory formation should not simply be:

experience -> generate memory -> store

It should be:

experience
-> generate candidate cues/description
-> retrieve existing associated memories
-> compare the new experience with prior experiences
-> decide whether this is:
   - the same general pattern
   - a reinforcement of an existing pattern
   - a genuine exception
   - a possible contradiction
   - a new pattern
-> update/create memory accordingly

This feedback loop is essential.

The memory system is self-referential:

new experience -> retrieve memory -> interpret experience -> modify memory

## Associative index

Use PostgreSQL in production.

There is no reason to require a different database merely because the index is associative.

Do NOT model this as a conventional composite key.

Use an inverted many-to-many index:

cue/phrase -> memory IDs

For example:

revenue -> M1, M7, M22, M81
finance -> M1, M7, M19
recognized revenue -> M1, M19
fact_revenue_v2 -> M1
major code 003 -> M44, M91

A retrieval request supplies a collection of language cues.

For example:

revenue
Q3 revenue
major code 003
finance
recognized revenue

The index retrieves candidate memories associated with those cues.

Then rank candidates using standard information-retrieval ideas such as:

- frequency/rarity of the cue
- number and quality of matching cues
- phrase/n-gram matches
- learned association strength
- historical usefulness
- scope
- recency where appropriate

BM25-like lexical ranking is a good starting point.

Do not put vector search in the hot path.

## Phrases, not just words

Plain single-word matching is insufficient.

The associative index should support phrases / n-grams.

For example:

revenue
recognized revenue
revenue calculation
major code 003
finance reporting
historical revenue query

A practical first implementation can generate/store 1-4 gram phrases from the language representation produced by the agent, rather than blindly generating every n-gram from the entire conversation.

Phrase matching should be stronger than generic word matching.

## Three-level inheritance

Memory is scoped:

GLOBAL -> GROUP -> USER

There are three associative indexes, or one physical implementation partitioned by scope.

A retrieval at USER scope should search:

USER
GROUP
GLOBAL

without copying memories between scopes.

Inheritance means visibility, not duplication.

Scope is one ranking factor, not an absolute override.

A highly specific and repeatedly useful global memory can be more relevant than a weak user-specific memory.

## Retrieval should use the current evolving context

Do NOT generate memory search cues only from the original user question.

The agent's state evolves during discovery.

At any point where memory could materially help, generate retrieval cues from the current context, including relevant conversation history and discoveries made so far.

Example:

Question:
"Calculate revenue for 003."

Later discovery:
"Finance wants to reconcile it against the P&L."

The useful retrieval context has now changed.

Memory retrieval should therefore be possible throughout the trajectory, not just once at the beginning.

The retrieval cue generator should consider the relevant session context, not merely the latest user message.

Do not necessarily retrieve after every token/message. Trigger retrieval at meaningful reasoning/discovery boundaries to keep cost and noise under control.

## Exploration vs exploitation

A major risk is that successful memory retrieval causes the agent to reuse a previous solution when the current situation is actually different.

This is the classic exploration vs exploitation problem.

Memory must therefore be advisory, not authoritative.

A retrieved memory should help the agent recognize prior experience, but the agent must retain the ability to investigate whether the current situation is actually equivalent.

In particular:

- high-confidence prior memories should reduce unnecessary work
- they should NOT force reuse
- unfamiliar or weakly matching situations should encourage exploration
- the system should deliberately allow some exploration even when a memory looks highly relevant
- new evidence should be able to override, specialize, generalize, or contradict prior memories

A practical approach is to expose retrieved memories together with their evidence/history and let the agent decide whether to reuse them.

The memory system should also record whether reuse succeeded or failed.

Failures are important learning signals.

## Stable attractor

The central long-term objective is stability.

Think of each experience as a point in a large, language-described state space.

Initially there may be many apparently different memories:

experience 1
experience 2
experience 3
experience 4

Repeated successful reuse should cause these experiences to converge toward a common memory/attractor when they actually behave the same.

For example:

revenue + 003 + finance
revenue + 007 + finance
revenue + 005 + finance

may eventually reveal that the product code is irrelevant.

They should converge toward:

revenue + finance -> recognized revenue

If repeated evidence shows that 003 genuinely behaves differently, the attractor should split:

revenue + finance -> Rule A
revenue + finance + 003 -> Rule B

The system should therefore repeatedly:

compress/generalize
-> observe new evidence
-> detect exceptions/contradictions
-> specialize where necessary
-> compress again

The goal is not maximum specificity.

The goal is maximum stable generality consistent with evidence.

## Contradictions

Never assume that a previous answer was simply "wrong" and the new answer is "correct".

Both can be correct under different conditions, or the system may only have a partial view of the real system.

Example:

Memory A:
revenue -> recognized revenue

Memory B:
revenue + supply chain -> shipped revenue

This is not necessarily a contradiction. It may reveal a contextual distinction.

Likewise:

Memory A:
revenue + 003 -> Rule A

Memory B:
revenue + 003 -> Rule B

should trigger investigation rather than automatically replacing A with B.

The system should preserve competing experiences until evidence explains the difference.

## Memory updates

Memory must be mutable.

Useful operations include:

- reinforce
- weaken
- merge
- generalize
- specialize
- supersede
- split
- preserve as competing hypothesis
- invalidate when sufficient evidence exists

Do not physically erase historical experience merely because a newer solution appears better.

Maintain enough history to understand how a memory evolved.

A new solution may turn:

Rule A

into:

Rule A under condition X
Rule B under condition Y

rather than simply replacing A.

## Daily reconciliation

Vector/semantic processing is useful, but should not be part of the main retrieval engine.

Run an offline reconciliation process periodically, for example daily.

It can use embeddings and an LLM to identify:

- semantically similar memories
- duplicate memories
- memories that should merge
- memories that appear contradictory
- memories that should generalize
- memories that should specialize
- weak or obsolete associations
- stable clusters/attractors

This expensive process is where semantic similarity belongs.

The hot path should remain:

language cues -> associative inverted index -> lexical/association ranking -> memories

## Suggested PostgreSQL model

Keep the data model simple.

memories

- id
- scope_type: global | group | user
- scope_id
- content
- strength
- usage_count
- success_count
- failure_count
- created_at
- updated_at

memory_cues

- memory_id
- cue
- weight

cue_index

- scope_type
- scope_id
- cue
- memory_id

The physical schema can be optimized later. PostgreSQL is sufficient for production unless actual scale measurements demonstrate otherwise.

Use normal PostgreSQL indexes for the inverted index.

## Association learning

Do not assign arbitrary permanent importance to a cue merely because it occurred once.

Instead, maintain evidence about associations.

Example:

Experience 1:
revenue + 003 -> Rule A

At this point, 003 is not known to be important.

Experience 2:
revenue + 007 -> Rule A

This is evidence that 003 may not matter.

Experience 3:
revenue + 003 -> Rule B

Now there is evidence that 003 may distinguish behavior.

Experience 4:
revenue + 003 -> Rule B

The association becomes stronger.

Experience 5:
revenue + 005 -> Rule A

The distinction becomes even stronger.

The system should learn from this repeated comparison.

Crucially, the comparison requires retrieving the existing memories during memory formation.

## Avoid premature state explosion

Do not create a new specialized memory for every combination of observed phrases.

This would produce:

revenue + 003
revenue + 004
revenue + 005
revenue + 006
...

even when all of them use the same rule.

Prefer one general memory until evidence demonstrates a meaningful distinction.

This is the most important protection against memory fragmentation.

## Practical hot-path algorithm

At a meaningful agent reasoning boundary:

1. Construct a language representation of the current relevant session context.
2. Generate a small set of meaningful cues/phrases.
3. Search USER, GROUP, and GLOBAL inverted indexes.
4. Merge candidates.
5. Rank using lexical/phrase overlap, rarity, learned association strength, scope, and historical usefulness.
6. Return a small number of memories.
7. Give those memories to the SAME agent as contextual experience, not as authoritative rules.
8. Let the agent decide whether to reuse, verify, or explore.
9. Record the outcome when known.

At a successful discovery/commit point:

1. Clone the SAME agent at that point.
2. Give the clone the task of extracting the useful experience and associative cues from the full trajectory.
3. Retrieve existing memories using those cues.
4. Compare the new experience with relevant prior experiences.
5. Reinforce existing memories when they are the same underlying pattern.
6. Create a new memory only when the evidence indicates a genuinely new pattern.
7. Increase specificity only when repeated evidence supports it.
8. Record contradictions/competing hypotheses rather than blindly replacing history.

## The important distinction

The system should NOT try to answer:

"What is the exact state of the world?"

It should answer:

"What prior experiences are strongly associated with the situation I appear to be in?"

And memory formation should NOT ask:

"What exact state applies to this experience?"

It should ask:

"What should another instance of the same agent be reminded of if it encounters something like this?"

That keeps the system associative, language-based, adaptive, and capable of discovering stable attractors without requiring a rigid state ontology.

## Summary architecture

Agent
-> evolving conversation/context
-> language cues
-> associative search across User/Group/Global
-> ranked memories
-> agent decides reuse vs exploration
-> new experience
-> cloned same agent at meaningful completion point
-> memory + associative cues
-> retrieve prior related memories
-> compare
-> reinforce/generalize/specialize/merge/preserve contradiction
-> indexes updated

Periodically:

memories
-> semantic/vector reconciliation
-> discover clusters, duplicates, contradictions and possible attractors
-> propose/perform memory consolidation

The primary system remains PostgreSQL + inverted associative indexes. Vector processing is an offline reconciliation/consolidation mechanism, not the primary memory retrieval mechanism.
