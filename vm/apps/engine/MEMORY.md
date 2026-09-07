# Associative memory — design (NOT BUILT)

**Status: design only.** Nothing here is implemented. The working system is untouched and stays that way
until a piece of this is explicitly picked up and built. This file exists so the reasoning survives the
conversation that produced it.

Design input: `docs/stable-attractor-associative-memory-source.md` — a note from another architect, kept
verbatim. This document is our reading of it, what we already do, where we disagreed, and what we concluded.

---

## The problem this solves

Concept retrieval today fires **once, from the question text**, before any work is done (span firing —
`retrieval/span-firing.ts`, wired at `engine.ts:896`). That is a structural ceiling, not a tuning issue.

The cues that actually discriminate between two ways of answering only come into existence *after* the agent
has looked at data: "this join duplicates rows", "this column is null before 2024", "the original query times
out, use the optimized one". No n-gram of the user's question can carry any of that. The same question asked
against changed data should take a different path, and question-only firing cannot see the difference.

There is a useful consequence. Discovery cues are **rare** and attach to few memories; question phrases are
**common** and attach to many. So a weighted index privileges discovery cues over question cues automatically,
with no rule saying so.

---

## What already exists (verified, not assumed)

- **FTS5 over nodes** — `label`, `summary`, `props`, kept in sync by triggers
  (`packages/node-store/src/schema.ts:38`). The lexical half of the inverted index is already built and
  maintained.
- **FTS5 over the datasource index** — one row per field, keyed `SOURCE.CONTAINER.FIELD`, searchable by name,
  type and description (`packages/node-store/src/datasource-index.ts`).
- **`desc_ai` / `desc_human` per field** — already in the schema, already in the FTS, currently **empty**
  ("later" in the comment). The slot for field-level annotation exists and is unused.
- **`hybridSearch`** — RRF fusion of lexical + vector, similarity for ordering
  (`packages/node-store/src/semantic.ts:102`).
- **Bitemporal concepts** — a rewrite archives `concept:<name>@v<n>`; only the live row is indexed, so a
  superseded belief never surfaces, and history is never destroyed.
- **Status ladder** — `unverified → corroborated (≥2 independent analyses) → verified (human only)`.
- **System 4 consolidation** — the concept modeller, watermark-driven, drains finished analyses on a timer.
- **Retrieval A/B** — `USE_SPECIFICITY=1` selects lexical name-word specificity; default is span firing.
  Exactly one retriever is surfaced, never mixed.

**What does not exist:** any record of which concepts were surfaced for a question, whether they were used, or
whether the answer succeeded. `conceptNames` is computed, logged and handed to the agent — and never persisted
(`engine.ts:913`). There is no cue table, no weights, no outcome feedback. We cannot currently score our own
A/B.

---

## Decisions

### 1. Memory and concept are two kinds, one index, one evidence mechanism

They are **not** the same thing, and an early attempt to merge them was wrong.

- A **concept** replaces the semantic model an enterprise would otherwise maintain by hand: a named business
  quantity with a definition, verifiable against data, part of a stable shared vocabulary.
- A **memory** is general and needs to be none of those. It can encode an approach, a pitfall, an
  environmental fact, a workaround. "The original query is too slow" is never a semantic-model entry and must
  not be forced into that shape.

Both are atomic. What they share is the plumbing: **one ranked list at retrieval** (the agent does not know in
advance which kind it needs — it knows what it is looking for), and **one cue/evidence layer** underneath.

Their strength axes differ and must not be conflated. A concept's `status` asks *did we re-derive it and does
it hold*. A memory's strength asks *did it help, how often, under what conditions*. Same plumbing, different
question. Presentation should mark the difference: a concept is a definition you follow, a memory is an
experience you weigh.

**The promotion path is where it gets interesting.** Repeated memories circling the same business quantity are
the signal that a concept wants to exist — an attractor forming *across* kinds. That is a far better trigger
for System 4 to mint a concept than "the analyst answered some questions".

### 2. The inverted index — store every cue, fire on the discriminative subset

Store every cue observed. Learn which ones matter. For a memory `M` and cue `c`, against the memories `M`
competes with (its siblings under the same core):

```
w(c, M) = log( (n(c, M) + α) / (n(c, siblings) + α) )
```

- A cue that appears with `A` and with `B` about equally → ratio ≈ 1 → **w = 0**. Observed, stored, inert.
- A cue that appears only with `B` → **w > 0 for B, w < 0 for A**. The negative half is the important one: a
  cue that *suppresses* a memory is how a general rule stops firing once a genuine exception is present.

IDF falls out for free — a cue attached to everything scores a ratio near 1 against every sibling set, so it
weighs nothing without a separate rarity term.

So: **cue set = everything observed. Firing set = cues with non-zero weight.** The inert cues are retained
precisely because they are the evidence that lets a weight change later. This is what makes "specificity is
earned" a mechanism rather than a sentence in a prompt — and we have already paid for the prompt-only version
once, when the concept store filled with question-named concepts.

Competing memories coexist. Relevance decides. Nothing is deleted to make room.

### 3. Stability under drift

An index alone flaps — split on one observation, merge on the next. Four things make it an attractor:

1. **Two thresholds, not one.** Splitting demands more evidence than staying merged (a Schmitt trigger).
   Merging back happens at a *lower* bar than the one that caused the split. One contradicting observation
   never splits; it accumulates.
2. **Split cost scales with support.** A memory with fifty confirmations needs proportionally more
   contradicting evidence to break than one with two. This is what makes it a basin rather than a lookup —
   depth resists perturbation.
3. **Decay, not deletion.** Evidence has a half-life, so genuine drift eventually wins, but a single new
   observation cannot flip a deep attractor. Stable, not frozen.
4. **A split is provisional until it earns a name.** Contradicting evidence first attaches to the existing
   memory as a competing hypothesis on the same atom. It becomes its own memory only after *k* independent
   confirmations. This is the direct protection against state explosion: the default is always the more
   general memory.

### 4. Two flavours of cue

- **Language cues** — phrases, from questions and from the agent's own searches.
- **Structural cues** — a specific `SOURCE.CONTAINER.FIELD`. We already maintain this key space, flat and
  name-based by design, so structural cues slot into an identifier space that exists.

`query` produces structural cues, not phrases: what you learn after running one is "this table has duplicate
rows", "this join fans out". Those attach to an object, not to language.

### 5. Field description ≠ field memory

Both are wanted, and they must not share a column.

- A **description** is singular and overwritten — one current best statement of what a field means. That is
  what `desc_ai` / `desc_human` are for, and they feed search ranking.
- **Memories** about a field are plural, episodic, evidence-backed and often conditional. One field has one
  description and many memories.

They connect: System 4 crystallising accumulated field memories into `desc_ai` means the description improves
from use, rather than being written once by an agent guessing at a column.

### 6. The clone is necessary — it is a signal, not a payload

An earlier proposal — the agent deposits a cheap string, a seam interprets it asynchronously — does not work.
Interpretation needs three things at once: the trajectory, the ability to go back to the data and validate,
and the ability to search memory. Nothing without the agent's context can do that, and a small model handed a
string is guessing about work it did not do.

The reframe that resolves it: **`./remember` is a signal. The payload is the session, not the parameter.** The
agent says "something worth keeping just happened here", perhaps with a one-line gist so the clone knows which
thread of a long trajectory to look at. The clone reads the rest from its own context.

The clone is not overhead beside the algorithm — the clone *is* the algorithm: generate cues → retrieve
existing → compare → decide reinforce / specialise / new can only run somewhere that holds the experience.

Cloning is cheap on pi/opencode (the composer runs on pi), so this can fire at every discovery rather than at
a few blessed points.

**Fire on success only.** Do not *form* memories from failures. But *do* record outcomes including failures
against memories that were retrieved — a memory that was offered and did not help is a weight update, not a
new memory.

**Queue invariant.** We hold that every agent is one session behind a queue, never parallel sessions of the
same agent. A clone is literally a parallel session of the same agent. The resolution: a clone is not the
agent continuing, it is a **write-only branch** with its own lifecycle — seeded from a session, one turn,
dies, never returns to the queue. That makes it a distinct role born from another's context, and the invariant
survives.

**Why a cheap model is safe here.** A weak writer will sometimes misjudge same-pattern vs genuine exception.
That is acceptable *because* System 4 sits downstream: online is cheap, plural and provisional; offline is
expensive, compressing and authoritative. The maturity ladder is what makes it safe, which is also why the
ladder must not be decoration.

### 7. Retrieval rides on the seam

There is no separate "retrieve memory" step to design.

**The agent's own search phrase is the best cue we will ever get** — it is the agent's current hypothesis, in
language, at the moment the hypothesis matters. Strictly better than anything in the user's original question.
Every search-shaped seam call hands us a high-quality cue set for free.

So any seam that takes a phrase returns memories alongside its own results: `introspect "customer billing"`
returns fields *and* memories about customer billing. Retrieval happens when the cue set materially changes —
not on a timer, and not only when the agent is stuck (by then the path is already chosen).

All data access already goes through the seam, so the choke point built for provenance turns out to be the
right place to hang associative recall.

### 8. Search versus fetch — one search verb, several fetch verbs

The agent's real question is never "introspect", it is *"where does X live?"*, which is a search. Browsing
structure is what you do when search fails.

- **`find <phrase>`** — searches everything (concepts, memories, fields, sources) and returns one mixed ranked
  list. `find-concept` being memory search stops being a special case and becomes the general case.
- **`introspect <source>`** — hierarchical browse, live, with stats and joins. Kept, because a flat ranked list
  destroys exactly what makes a field usable: which container it is in, its grain, keys, what it references.
  Browse is how you work when you do not yet know the vocabulary; search is how you work when you do.

The live/static split already documented in `datasource-index.ts` (introspection is live and per-source; the
index is always-available pure structure) is worth preserving rather than blurring. `sources` folds into
`introspect` with no argument.

### 9. Vectors move to cold start and offline

What vectors buy today is synonym recall — "billed revenue" reaching a concept named "recognised revenue" with
no synonym map. Once cues are learned from usage that problem largely dissolves, because harvested aliases and
cues **are** a synonym map, built from evidence instead of from an embedding's guess.

Target state: **FTS + learned cues in the hot path; vectors for cold start and offline consolidation** (System
4 needs them for clustering and dedup regardless). Vectors also stay in program-candidate search over intents,
which is a separate path and not affected.

The one real gap is cold start: on day one there are no learned cues and few aliases, and FTS retrieves nothing
where vectors would retrieve something.

**This is to be measured, not asserted.** Once outcome logging exists, FTS-plus-cues can be scored against span
firing on real questions using the A/B rig we already have — which finally gets a scoreboard.

---

## Ordering constraints

These are not preferences; each one blocks the next.

1. **Outcome logging first.** Persist which memories/concepts were surfaced per qid and what happened. Changes
   no behaviour, unblocks everything, and makes the existing A/B measurable.
2. **The evidence layer before frequent remembering.** Cheap clones firing at every discovery *without* cue
   weights is premature state explosion one level down — thousands of provisional memories and nothing to sort
   them by. The weights must exist before remembering is turned up.
3. **Weighted retrieval last.** Replacing question-only firing as the entry point is only worth doing once
   there is evidence to weight with.

---

## Open questions

- Whether structural and language cues share one weighting scheme or need different ones.
- What stops unverified deposits from crowding out verified concepts in a merged ranked list, before the
  evidence layer has enough observations to sort them.
- How a clone's write is reconciled if two clones deposit about the same discovery concurrently.
- Whether `k`, the two thresholds, and the decay half-life are learned or configured — the project rule is
  that defaults are learned from usage, never constants, which suggests learned, but there is no signal to
  learn from until (1) exists.
