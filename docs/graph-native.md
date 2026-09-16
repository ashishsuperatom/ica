# Graph-native: patterns, laziness, and the laws that make them pay

*Design for the `graph/native` branch. The question stops being a record and becomes a graph value; computation
stops being eager and becomes demand-driven; composition stops being a rewrite and becomes an operation with laws.*

---

## 0. Why, in one paragraph

Everything we have been blocked on this month is a consequence of the question being a **record** and the
computation being **eager**: no filter can be pushed into a program (so a one-project question reads nine months of
the whole company), no two questions can be composed (so an agent re-derives from scratch), a follow-up has no
coordinates to move (so it re-reads the conversation and guesses), a partial idea cannot be handed in (so the agent
tries and retries), and nothing is reused between attempts (so three tries cost three times). Each of those is a
separate patch in the record world. In the pattern world they are one property: **a question is a value in the same
category as the schema, and evaluation is demand-driven over content-addressed nodes.**

---

## 1. The core objects

### 1.1 The schema is a category (we already have this)

Objects (entities, facts, calendar levels), arrows as total functions, path equations. Arrows being functions is
what makes a join incapable of multiplying rows; equations are what make two routes the same route.

### 1.2 A pattern is a diagram in that category

A **pattern** is a finite graph `P` with a labelling into the schema: each node labelled by an object, each edge by
an arrow, subject to the schema's equations. On top of that, nodes carry **decorations**:

| decoration | meaning |
|---|---|
| `group` | this node's members are an output coordinate |
| `keep` | a predicate on this node's members (in / not-in / range / under / none / text) |
| `measure` | an aggregation of a fact's measure, rooted at a fact node |
| `derive` | an expression over other measure nodes (a ratio, a difference) |
| `span` | a window on a calendar node |
| `as-of` | the day the answer is given as of |
| `unit` | the currency or unit the answer reports in |

The question we ran tonight, as a pattern:

```
(AllocationDay) -[day]-> (Day) -[month]-> (Month)          :group  :span 2026-09-01…2026-10-31
(AllocationDay) -[project]-> (Project) -[subsidiary]-> (Subsidiary)  :keep in {AU}
(AllocationDay) :keptTo (valid project)
(BudgetLine)    -[month]-> (Month)                          ← the same Month node
(BudgetLine)    :keptTo (base revenue budget)
:measure sum(AllocationDay.revenue)   :measure sum(BudgetLine.budget)
:derive  ratio = sum(AllocationDay.revenue) ÷ sum(BudgetLine.budget)      :unit AUD
```

"Conformed dimension" is no longer a rule to check — it is the observation that **both facts touch one Month node**.

### 1.3 Morphisms of patterns are the moves

A map `P → Q` that preserves labels and decorations is a **refinement**. Every interaction is one:

- **drill down**: `Month` node replaced by `Day`, edges extended — a morphism;
- **slice**: attach a `keep` to a node — a morphism;
- **add a measure**: attach a measure node to a fact already in the pattern — a morphism;
- **compose two questions**: the pushout of two patterns over their shared subpattern (the shared dimension nodes).

So a conversation is a path in the category of patterns, and the session state *is* the current pattern. A
follow-up is applying a morphism, not re-reading English. This is the missing state we hit with program answers.

### 1.4 A strategy is a pattern over patterns

Because patterns are values in a category, a method — "count rows meeting a per-row rule, per entity, over a window"
— is a pattern **with holes**: a pattern-shaped functor whose variables are instantiated by matching against a
question. Retrieval of methods becomes pattern matching (a homomorphism search), not similarity over text. This is
the programs/method layer, and it needs no new machinery beyond what patterns already are.

---

## 2. Evaluation is lazy and content-addressed

### 2.1 A plan is a DAG of operations, not an action

Compiling a pattern yields a **plan graph**: `read` (a binding's statement), `produce` (a program), `filter`,
`expand`, `join`, `aggregate`, `convert`, `derive`. Nothing runs. Each node is identified by the **hash of its
definition plus its inputs' hashes**, so identical work anywhere in the system is literally the same node.

### 2.2 Demand drives execution

The consumer asks for cells — "the first 20 rows ordered by revenue", "the total", "this one group's detail". The
evaluator pulls only the nodes those cells need. Consequences:

- a `limit` reaches the source instead of being applied after reading everything;
- a program that produces an object nothing asks for never runs (we fixed one instance of this by hand today; here
  it is structural);
- a detail view of one group re-uses the aggregate's own subtree rather than recomputing it.

### 2.3 Results are memoised by node hash

A node's result is stored against its hash, with the source watermark it was read at. Then:

- the composer's three attempts at tonight's question pay the 30-second read **once**;
- two people asking overlapping questions share subtrees (the same allocations, the same spread, the same month
  aggregate);
- a corrected definition invalidates exactly the nodes downstream of it — nothing more, nothing less;
- a counterfactual ("what if this allocation were hard?") is an overlay node: everything upstream is reused, only
  the affected subtree recomputes. What-ifs become cheap by construction.

### 2.4 Pushdown is graph rewriting, and it applies to programs too

`filter` nodes move toward sources by rewrite rules that are stated once and proved once (a filter on a path may
cross a join when the path is on the preserved side; a filter on a grain arrow may cross an expansion; and so on).
A **program declares its ports**: which decorations it accepts (a span, a set of projects, a set of people). A
filter that reaches a port is handed to the program instead of applied after it. Tonight's nine-month,
whole-company spread becomes a read of one project's allocations — without giving up code.

---

## 3. The laws that make this more than a refactor

These are the parts where category theory earns its place; each one buys a concrete capability.

### 3.1 Aggregation along an arrow is a Kan extension

Grouping is aggregation along the arrow from the fact to the grouping object; roll-up between calendar levels is a
functor. Stating it this way gives one uniform rule for "aggregate along a map", from which summarisability falls
out as a theorem rather than a checklist: what may be aggregated along which arrow kind is determined by the
measure's structure, not by a table we maintain.

### 3.2 Measures are monoids (and value-per-unit is a monoid on pairs)

`sum`, `count`, `min`, `max` are monoids; `average` is the monoid on (sum, count); a weighted average is the monoid
on (weighted sum, weight). Associativity is what licenses **partial aggregation**: compute by day, reuse for month
and quarter; shard across sources and combine; update incrementally when new rows arrive. Today every grouping
recomputes from rows because nothing guarantees the fold is associative.

### 3.3 Drill-across is a pullback

Two facts joined on shared dimension nodes is a pullback in the category; that is exactly why aggregating each side
first and joining on keys is correct, and why a dimension one side cannot reach makes the question ill-formed
rather than merely awkward.

### 3.4 Programs as effectful computations over the graph

A program is a computation whose effects are graph reads (`ask`, `query`), declared in its type. Then the same
laziness and pushdown apply to it: its reads are plan nodes, memoised and rewritten like any other. Code stays code
— we are not converting programs into a DSL — but it stops being an opaque box the planner must respect.

### 3.5 Corrections are lenses onto definitions

A correction is a focused update on a definition node, with provenance edges saying what derives from it. "Below
threshold means −30 points" edits one node; every pattern that touches it re-derives; every answer that used the
old node is identifiable by hash. Convergence becomes mechanical rather than cultural.

---

## 4. What this gives us, measured against what matters

| property | today | graph-native |
|---|---|---|
| **Correctness** | rules checked on a record; a program's internals are opaque | rules are constraints on the pattern plus laws on the plan; programs' reads are visible nodes |
| **Determinism** | same wording → maybe the same canonical question; program answers are not canonical at all | same pattern → same plan hash → same answer, cited by hash; reuse is exact, never fuzzy |
| **Runtime** | every attempt re-reads; no pushdown into programs; eager reads | demand-driven, memoised, pushed down; three attempts cost one read |
| **The agent's job** | write JSON, guess paths, retry on timeouts, re-derive follow-ups | hand in a partial pattern; get ranked completions; moves are morphisms; retries are free |
| **Power later** | strategies would need a new mechanism | strategies are patterns with holes, matched by homomorphism — same machinery |
| **Stability** | a correction lands in one definition, but its blast radius is found by search | invalidation follows provenance edges exactly |

---

## 5. What already exists (so this is a build, not a leap)

| needed | we have |
|---|---|
| schema as a category, equations | `schema.ts`, `paths.ts` (`normalise`, `walk`, `pathsFrom`) |
| resolving a target to a path, with alternatives | `reach()` in `algebra.ts` (rule A2 returns the choices) |
| a resolved plan per fact | `Plan` / `FactPlan` — a pattern in all but name |
| SQL per dialect from a plan | `sql.ts` (joins from arrows, conditions, conversion, stocks) |
| content hashing of definitions | `hashOf`, `canonicalJson` in `runtime.ts` |
| recorded calls with the nodes they touched | `store.ts` (`call`, `call_node`), provenance by hash |
| programs with declared reads | `producers.ts` (`ProgramDef.reads`) |
| a Cypher-like rendering | `patterns.ts` |

What is genuinely new: the **Pattern value and its operations** (glue, refine, match, complete), the **lazy plan
graph with a memo store**, the **rewrite rules for pushdown**, and **ports on programs**.

---

## 6. Build order

Each stage lands on its own, keeps every existing test green, and is useful before the next begins.

1. **Pattern as a value.** `pattern.ts`: the type, `fromQuestion` / `toQuestion`, structural hash, pretty-printer.
   Gate: every existing test produces an identical plan when routed through the pattern.
2. **Operations on patterns.** `glue` (pushout over shared nodes), `refine` (the moves as morphisms), `match`
   (homomorphism search). Gate: tonight's revenue-vs-budget question built by gluing two single-fact patterns;
   every move in `moves.ts` expressed as a refinement.
3. **Completion.** Partial pattern → ranked completions, with the ambiguity surfaced rather than guessed. Gate: the
   questions the composer wrote by hand this week are produced from fragments.
4. **The lazy plan graph.** Operations as nodes, hashed by definition+inputs; the evaluator pulls what the consumer
   demands. Gate: identical answers; a `limit` reaches the source; an unneeded program never runs.
5. **The memo store.** Results by node hash with a source watermark. Gate: the composer's repeated attempts read the
   source once; a second question sharing a subtree reuses it.
6. **Pushdown rewrites, including ports on programs.** Gate: the one-project, nine-month question reads one
   project's allocations; measured before and after.
7. **Laws in the checker.** Summarisability from the measure's structure; partial aggregation licensed by
   associativity. Gate: the existing rule tests pass unchanged, and partial aggregates are reused across groupings.
8. **Strategies as patterns with holes.** Gate: a method written once matches three of the Fusion5 scenario
   questions and instantiates correctly.

Stages 1–3 make the agent's job better. 4–6 are where runtime and determinism improve. 7–8 are where the system
starts compounding.

---

## 7. Open questions worth deciding early

- **Ranking completions.** When a fragment has several completions, what orders them — path length, declared
  defaults, past usage? Wrong ranking answers a question nobody asked, so the rule must be visible in the answer.
- **Rewrite confluence.** Pushdown rules must not depend on the order they fire. Keep the set small and prove it.
- **Invalidation granularity.** Per node is correct; per source watermark is what makes it cheap. Both need a clear
  freshness contract from each adapter.
- **What a person sees.** A pattern is a better thing for an agent to hold, but the person still reads an answer.
  Programs stay the layer that shapes reading; nothing here changes that.
