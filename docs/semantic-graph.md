# The semantic graph

The semantic model as a mathematical object: a schema graph, instances of it, and an algebra of questions over it. Every
answer is correct by construction, or the question is refused with the reason. What can still be wrong is how the
schema is declared and what the programs that produce its data return, and both are checked.

This document is the specification. Code follows it; a failing test is a bug against a rule stated here, or a mistake
in a declared schema, never an open question about what the rule is.

---

## 1. Foundations

The design takes established results, not new ones:

| Result | What it gives here |
|---|---|
| **Categorical databases** — a schema is a finitely presented category, an instance a functor to sets; queries and data migrations are functors (Spivak 2012; Schultz, Spivak, Vasilakopoulou, Wisnesky, *Algebraic databases*, 2017; the CQL language) | Objects, arrows as total functions, composition of paths, path equations, and data migration along schema maps |
| **Summarizability** — when an aggregate over a hierarchy is correct: disjoint and complete hierarchies, and aggregate functions compatible with the measure's type: flow, stock, value per unit (Lenz & Shoshani 1997; Horner, Song & Chen 2004) | Which aggregate may travel along which arrow |
| **Multidimensional models** — dimension hierarchies, non-strict and non-covering hierarchies (Pedersen & Jensen 1999) | Hierarchies that are not trees, and partial arrows |
| **Dimensional modelling** — conformed dimensions, drill-across, role-playing dimensions, the fan trap and the chasm trap (Kimball & Ross) | Combining facts; one entity reached in several roles |
| **Temporal data** — slowly changing dimensions, valid time (Snodgrass; Kimball type 2) | Arrows whose value depends on the date |
| **Quantity calculus** — units and dimensions of quantities (ISO 80000-1) | Which measures add, which multiply, conversions |
| **Structural causal models** — interventions and counterfactuals on a causal DAG (Pearl 2009) | What-if, counterfactual, cause and effect |

---

## 2. The schema

The definitions of every term — entity, attribute, calendar, fact, grain, measure, arrow, condition, and the derived
dimension, path and conformed dimension — are in `vm/packages/semantic-graph/CONCEPTS.md`, kept with the code.

A schema **S** is a directed graph with typed nodes and typed arrows, and equations between paths.

### 2.1 Objects

- **Entity** — a set of things with identity: Project, Person, Pillar, Currency. It may list its **members** and the
  **names** people use for them (`AU` → Subsidiary 2). An entity may be a **calendar level** (Day, Month, Quarter, Year,
  or an organisation's fiscal levels).
- **Fact** — a set of events at a grain: `AllocationDay` is one person on one project on one day. A fact carries
  **measures**. Its grain is the set of its **grain arrows** (2.2); two rows of a fact never share all grain values.
- **Attributes** — values a fact row or an entity element carries that lead nowhere: a project's RAG, its go-live date,
  its total budget. Each has a type (text, date, number, flag); text may list its values. Grouped and filtered by —
  dates and numbers by range — never added up.
- **Conditions** — a condition people name ("a valid project", "the PMO population") is one definition: filters on the
  object it is about. A question keeps to it by name from any fact that reaches that object; a fact may be **kept to**
  some conditions always, unless a question sets one aside. A source that holds only its **current state** says so.

### 2.2 Arrows

Every arrow `f: A → B` is a **function**: each element of `A` has at most one image in `B`. A many-to-many relationship
is never an arrow — it is a fact with two arrows out (a *span* `A ← F → B`).

| Kind | Meaning | Totality | Example |
|---|---|---|---|
| `grain` | a fact's coordinate | total | `AllocationDay.person → Person` |
| `belongs` | an entity belongs to one entity | total or partial (declared) | `Project.pillar → Pillar` |
| `rollup` | a level of a hierarchy into the next: strict and covering | total | `Branch.state → State`, `Day.month → Month` |
| `as-of` | belongs, but its value depends on a date (valid time) | total per date | `Person.pillar @ Day → Pillar` |
| `version` | a coordinate whose members are alternative versions, never combined | total | `BudgetLine.category → BudgetCategory` |
| `self` | an entity belongs to another of its own kind; forms a hierarchy by closure | partial | `Person.manager → Person` |

Hierarchies are not special to time. Branch → State → Region is a chain of `rollup` arrows exactly as Day → Month →
Quarter → Year is; drilling up and down is the same move on both. Time differs in three ways only: its members are
generated from keys rather than listed, it is ordered (spans, first and last), and it is when `as-of` arrows and stocks
are evaluated.

An arrow also has a **role**: its name. Several arrows may share a codomain — `Project.pillar` and `Person.pillar` both
land in Pillar — and are different arrows (role-playing).

### 2.3 Paths and equations

A **path** is a sequence of composable arrows; it denotes the composite function. A path may visit an object more than
once (`person.manager.manager`). Paths are bounded in length by the query, not by the schema.

A **path equation** declares two paths equal as functions: `AllocationDay.project.subsidiary.currency =
AllocationDay.project.currency`. Equations define the **normal form** of a path (§8.1) and are checked on the data.

### 2.4 Measures

A measure `m` of a fact `F` is a function `m: F → Q` into a **quantity type** `Q = (unit, kind)`:

- **unit** — `h`, `people`, `ratio`, or `money[c]` with its currency given by a path `F → Currency` or a currency
  attribute; units combine by quantity calculus (§6).
- **kind** (Lenz & Shoshani) — `flow` (accumulates over time: hours, revenue), `stock` (a level at an instant: headcount,
  balance), or `value-per-unit` (a rate: charge-out rate, exchange rate, price).
- **aggregate** — `sum`, `count`, `min`, `max` (distributive); `average` (algebraic: carried as sum and count);
  `count distinct` of an arrow (holistic: recomputed, never combined from parts); `last`, `first` over time.
- **versions** — optionally, a `version` arrow the measure must be grouped or filtered on.

A **derived measure** is an expression over measures (`revenue / budget`, `hours × rate`). It is evaluated after
aggregation, at the question's grain — never aggregated itself.

A **computed fact** is a fact whose rows are defined from other facts (`AllocationRevenue` from `AllocationDay` and the
rates it names). Its definition is a `computed-from` edge in the dependency graph (§9), not an arrow of the schema.

### 2.5 Well-formedness (checked when a schema is defined)

1. Every arrow's codomain exists; grain arrows are total; the grain of a fact is a set of arrows.
2. Every money measure's currency path exists and ends at `Currency`.
3. A `version` arrow named by a measure is one of its fact's grain arrows.
4. Calendar levels form chains of `rollup` arrows; a fact's time grain is one calendar level.
5. Every path equation relates two paths with the same domain and codomain.
6. No cycle of `belongs`/`rollup` arrows other than `self` arrows (a thing cannot belong to what belongs to it).
7. Names people use for members point at declared members.

---

## 3. Instances

An **instance** `I` of `S` assigns to each object a set of rows (keys) and to each arrow a function between them — the
data. Programs produce instances (§10). An instance **conforms** when:

1. every total arrow resolves each row exactly once; a partial arrow at most once;
2. no two rows of a fact share all grain values;
3. every path equation holds on every row;
4. an `as-of` arrow's validity intervals for one element do not overlap;
5. measures have their declared units; money has a currency.

Non-conformance is an error of the program producing the instance, reported with the rows that break the rule.

---

## 4. Questions

A **question** is a pattern `Q = (M, G, W, T, C)`:

- `M` — measures, each `(F, m)`; derived measures over them;
- `G` — grouping paths: for each fact `F` in `M`, a path from `F` to a **target object**; a target common to all facts is
  a *conformed* grouping;
- `W` — filters: a path to an object and a set of members, a condition on an attribute (of the fact, or of an object a
  path reaches — a set of values or a range), or a named condition;
- `T` — a time span on the facts' time paths, and for stocks an instant or a roll-up;
- `C` — coordinates applied to the result: order, limit, having, compare, cumulative, rolling, fill, totals, share.

### 4.1 Meaning

For one fact `F`, with grouping paths `p₁…pₙ` and filter paths `q₁…qₖ`:

    ρ_F(b₁…bₙ) = ⊕ { m(r) : r ∈ F, pᵢ(r) = bᵢ for all i, q_j(r) ∈ W_j for all j, r ∈ T }

where `⊕` is the measure's aggregate. Because every arrow is a function, each row lands in exactly one group: the fold
is a partition of `F`, so no row is counted twice (§5 rule A1).

For several facts, each is aggregated separately to the common targets, and the results are joined on those targets —
**drill-across**. Joining before aggregating is never done (the chasm trap).

### 4.2 Answerable

`Q` is answerable if and only if every rule in §5 holds. Otherwise it is refused with the first rule that fails, the
object or arrow involved, and — where the question left a choice — the paths to choose between.

---

## 5. The rules

Each rule is a consequence of §1, not a design choice.

**A. Paths**

- **A1 — Grouping is along functions.** Each grouping and filter path is a path of arrows from the fact. Nothing is
  reached against an arrow: from Pillar to its projects is not a function, and summing along it multiplies rows (the
  fan trap).
- **A2 — Roles are chosen.** When a fact reaches a target by several paths not equal under the path equations, the
  question names the path, or the fact declares a default for that target; otherwise the choices are returned.
- **A3 — Paths are normalised** by the path equations before comparison; two equal paths are one grouping.
- **A4 — Partial arrows** group their undefined elements into an explicit *none* member, never drop them.
- **A5 — `self` hierarchies** are aggregated over the reflexive-transitive closure only when the question asks for
  descendants ("everyone under"); otherwise a `self` arrow is an ordinary one-step path.

**B. Aggregation along arrow kinds** (summarizability)

| Measure kind \ arrow kind | `grain` / `belongs` | `rollup` (time) | `version` | `as-of` |
|---|---|---|---|---|
| flow, distributive | fold | fold | never across versions | at each row's date |
| stock | fold across non-time arrows | `last` / `first` / `average` over time, never sum | never across | at the instant |
| value-per-unit | never summed; weighted by its base only when declared | never summed | never across | at the row's date |
| `count distinct` | recomputed from the fact at each grouping | recomputed | never across | at the row's date |
| `average` | carried as (sum, count), combined | combined | never across | at the row's date |

- **B1** — A measure is aggregated only as the table allows for every arrow on its grouping paths.
- **B2** — Hierarchies must be **strict** (a function) and **covering** (partial arrows handled by A4) for a coarser
  total to equal the sum of finer totals; totals at coarser groupings are otherwise recomputed from the fact.

**C. Combining facts**

- **C1 — Conformed targets.** Measures of different facts are combined only at targets every fact reaches (§4.1).
- **C2 — Drill-across.** Each fact is aggregated before the join; the join is on target keys.
- **C3 — Scoped filters.** A filter on an object only one fact reaches — its own version or attribute — applies to that
  fact alone; a filter on a conformed target applies to all.
- **C4 — Derived measures** across facts are evaluated on the joined aggregates, at the question's grain only.

**D. Time**

- **D1** — A fact has one time grain. Grouping by a calendar level is valid only if it is reached from that grain by
  `rollup` arrows: a monthly fact is never grouped by day.
- **D2** — Relative spans resolve against the day the question is asked on, in the organisation's calendar.
- **D3** — `as-of` arrows are evaluated at each row's date. A row kept by a month, quarter or year is dated at the last
  day of its period.
- **D4** — A span is cut only at the boundaries of each fact's time grain: a monthly budget has no half of September.
- **D5** — A stock taken at the last or first instant of a group uses the instants of the group's time bucket across the
  whole fact, so a branch with no row in the last month has level 0 then, not its earlier level.

**E. Quantities**

- **E1** — Addition and comparison only between the same unit. `money[AUD] + money[NZD]` is not defined.
- **E2** — Conversion of money is a `value-per-unit` fact `Rate: Currency × Currency × Day → ratio`; the conversion date
  is the row's date or the span's end, as the organisation declares. A rate is a measured value: none dated after the
  day the answer is given as of is known, so the rate used is the latest on or before the earlier of the two dates. A
  planned rate is not a rate of this fact; it is a version of its own.
- **E3** — Multiplication and division form new units (`h × money/h = money`); a derived measure's unit is computed and
  checked against its declaration.

**F. Versions**

- **F1** — A measure with a `version` arrow is filtered to one version or grouped by version.
- **F2** — A fact whose source holds only its current state is answered as it stands now; a question as of an earlier
  day is refused, with the reason.

---

## 6. Navigation

Moves on a pattern `Q` keep it answerable when the rules are rechecked, and the valid moves can be listed:

| Move | On the pattern |
|---|---|
| drill up | a grouping path `p` becomes `p · f` for an arrow `f` out of its target (`project` → `project.pillar`, `day` → `day.month`) |
| drill down | `p · f` becomes `p` |
| slice | add a filter on a path's target to one member |
| dice | filters on several targets |
| pivot | reorder grouping paths into rows and columns (presentation only) |
| add measure | add `(F′, m′)`; valid only if `F′` reaches every target (C1) |
| drill through | from an aggregate cell to the fact rows in its group (the fold's fibre) |
| totals | the same pattern at a prefix of the grouping |
| share | a measure over its total at a coarser grouping |

The list of valid next moves from any answer is computed from the schema: out-arrows of each target (drill up), the
last arrow of each path (drill down), facts conformed at the targets (add measure).

---

## 7. State

A data session's **state** is a pattern together with assumptions, interventions and an as-of date:

    state = (Q, assumptions, interventions, asOf)

Every message is an operation on the state — split (add a grouping path), unsplit, drill up/down, slice, unslice, add
or remove a measure, set a span, compare, assume, intervene, as-of — and the new state is checked by §5 before anything
runs. A refused operation leaves the state unchanged and says why.

### 7.1 Canonical form

The **canonical form** of a pattern is: measures as `(fact, measure)` sorted; grouping and filter paths in normal form
(A3), sorted; spans as dates; coordinates in a fixed order. Two questions with the same canonical form are the same
question, whatever words asked them. It is the key for memory, series, expectations and reuse.

---

## 8. Results

A result is **typed by the schema**: rows keyed by the targets of the grouping paths, and a column per measure with its
unit. With it travel the pattern and the path of every column. Every column is therefore a node a next move can start
from, and every cell can be drilled through to the rows that produced it.

---

## 9. Programs and dependencies

A **program** produces part of an instance: the rows of an object and the functions of its arrows, from any source — SQL
against one database, calls to an API, computation across several. Programs are JavaScript; they are unconstrained
inside and constrained at their boundary: their output must conform (§3).

The **dependency graph** records `computed-from` edges: a computed fact from the facts and rates it is built on; a
derived measure from its measures; an answer from the patterns it asks. It is acyclic. A change to a node reaches every
pattern, answer and series downstream of it, and is known by traversal.

---

## 10. Interventions, counterfactuals and causes

- An **intervention** `do(·)` replaces part of the instance: a measure's values (`do(rate := 180)`), an arrow's value for
  some elements (`do(project 52262.pillar := FO)`), rows added or removed (`do(allocation += …)`). The pattern is
  unchanged; it is evaluated on the intervened instance `I′`.
- A **counterfactual** evaluates the same pattern on `I` and on `I′` for the same as-of date, and reports the difference.
- A **causal graph** over quantities — measures at grains — is declared with **structural equations**: the `computed-from`
  edges are structural by definition (`revenue = hours × rate`); other edges are declared assumptions (`utilisation →
  hiring`). An intervention on a variable replaces its equation (Pearl's do-operator); triage walks the causal graph from
  a surprising value to its causes.
- **Assumptions** are named values that programs read — by caller, group, person or organisation — and are part of the
  state (§7), so a what-if is a state, and comparable with the actual one.

---

## 11. Reading a question into a pattern

1. An LLM reads the question into **terms** with kinds: measures, targets, members, attributes, span.
2. **Anchors** — each term is matched exactly against the schema's words (names, synonyms, members, the names people
   use). Nothing is matched fuzzily here.
3. **Coherence** — only readings where all anchored terms form an answerable pattern are kept (§5). Several matches for
   one term are decided by the others.
4. **Repair** — an unmatched term's candidates are the nodes adjacent to the anchored part of the schema (measures and
   attributes of the anchored facts, targets they reach); the LLM chooses from that list.
5. **Learning** — a confirmed repair is stored as a synonym *scoped* to the node where it was confirmed, never globally,
   and only after the answer built on it is accepted.
6. **Ambiguity** — a remaining choice of role or fact is returned to the person as a question, never guessed.

The LLM never writes an identifier. It chooses among nodes and paths a tool has just shown it.

---

## 12. The agent's view

The schema is stored as tables — objects, arrows, measures, equations, members, names — and read into the same
structures the algebra uses. The agent is never given those tables, or SQL over them. It is given a graph:

| Tool | Answers |
|---|---|
| look at a node | its kind, description, arrows out, what points at it, measures, attributes, a few members |
| step along an arrow | the node at the other end — only arrows that exist |
| reach | every path from a fact to an object, in normal form |
| find a word | the nodes whose names, synonyms, members or names people use are that word |
| check a pattern | the plan, or the rule refused and the choices |
| moves from here | drill up, drill down and add-measure moves that are allowed |
| ask | the answer to a checked pattern |

Every tool speaks in nodes, arrows, paths and rules. There is no call that joins two things the graph does not connect,
so the agent cannot build a wrong question — only fail to find a right one, which it is told.

## 13. Relation to the program graph (removed)

| Program graph today | Semantic graph |
|---|---|
| a concept returning a relation | a program producing a fact's rows and arrows |
| a relation's `shape` (dimensions, measures, time) | the fact's grain arrows, measures and time grain; dimensions become paths to shared entities |
| `entity` on a dimension, `grain` on a shape | `grain` and `belongs` arrows |
| attribute paths `employee.manager` | paths |
| summarizability, currency, stock/flow checks | rules B, E, D |
| the `exchange rates` setting | the Rate fact and rule E2 |
| coordinates (order, limit, compare, rolling, totals, share) | `C` of a pattern, applied to the result |
| session state `{program, request, …}` | state as a pattern (§7) |
| interventions, counterfactual, assumptions, memory | §10 and canonical forms (§7.1) |
| names, members | entity members and names |

The program graph (`vm/packages/graph`) was removed on 2026-09-15, once the semantic graph had its own SQL, memory and
sessions and the agents answered with it; it remains in git history. This table is how its ideas map here.

---

## 14. Running where the data is

The semantic graph runs its own plans; it does not depend on the program graph. **Sources** say where each object's
rows are: for a fact, a statement returning its rows and the column of each arrow, attribute, measure and its time; for
an entity, a statement with one row per element and its arrows' columns, and a history statement for each as-of arrow.

A plan compiles to one SQL statement per fact, run through the datasource manager:

    SELECT <the end of each grouping path>, <each measure folded>
    FROM (<the fact's rows>) f
      LEFT JOIN (<an entity's rows>) …  ON key = <the path so far>                      each element once
      LEFT JOIN (<an arrow's history>) … ON key = … AND <row date> in [from, to)       each as-of arrow
    WHERE <span> AND <filters>                     everything under a member: a recursive subquery
    GROUP BY <the ends of the grouping paths>

Every join follows an arrow, and an arrow is a function, so no join repeats a row: the source computes exactly the fold
of §4.1. Money is multiplied by its rate — the latest on or before its conversion date, never after the as-of date —
before it is added, and a missing rate is an error, never zero. Facts are aggregated apart and assembled by the same
code as the reference evaluator (totals, shares, comparison, having, order, limit), which is the oracle every compiled
question is tested against. A stock taken at an instant per group is aggregated by instant at the source and finished
after. What differs between dialects is four functions: quoting, calendar keys, period ends, first-of-ordered.

One statement reads one source: an entity held elsewhere than its fact is refused until reading across sources is built.

## 15. Parity with the program graph (removed)

Nothing is copied from the program graph and nothing here depends on it; its capabilities were the checklist. Each is
built in `vm/packages/semantic-graph`, tested (102 tests) — or listed below as not yet.

| Program graph | Semantic graph | Where |
|---|---|---|
| programs by hash; names with history; libraries | schemas, sources, settings and programs as definitions by content hash, names with every pointing kept, libraries mounted read-only by namespace | `store.ts`, `runtime.ts` |
| call memory: request, output kept and counted, SQL, caveats, today, who, assumptions, interventions, lineage, bounded retention | the same, plus the canonical question, the plan, the exact schema/sources/settings/programs, and the graph nodes each answer went through (what a correction reaches is a lookup) | `store.ts` |
| observations, series summaries, expectations, surprises, triage | series keyed by the question apart from its span; Hampel expectations; surprises recorded; triage walks down the graph's own paths and into a computed output's parts, asking what it needs rather than relying on memory having it | `expectations.ts`, `runtime.ts` |
| data sessions: states, messages, branching tree | questions and moves, settings / interventions / as-of carried as session context, relative spans kept relative | `runtime.ts`, `moves.ts` |
| capped results refused; parts reconciled; entity grain guards | capped rows refused everywhere (answers, programs, joined objects); entity keys and histories guarded before rows are trusted; parts need no reconciling where the algebra guarantees them | `sql.ts`, `runtime.ts` |
| access policies per statement | passed with every statement an answer, a program, a drill-through or a member search makes | `sql.ts`, `runtime.ts` |
| assumptions and rules by who asks | settings from caller / asker / organisation / default, most-specific rules over who asks and what the question keeps; every value read recorded with its layer | `rules.ts` |
| relative dates, today by zone, calendars, time zones for moments | the same; calendars are schema objects (week, fiscal, listed) that commute; moments moved by the offset in force at each moment | `calendar.ts`, `time.ts` |
| replay, counterfactual | replay on the exact definitions and programs, as of the day answered; counterfactuals through SQL, hypothetical answers kept out of series | `runtime.ts`, `interventions.ts` |
| interventions on rows as SQL | rows removed, measures set or scaled, rows added, entity arrows moved (from a date for as-of arrows) — the same in memory and in SQL | `interventions.ts` |
| coordinates: measures, by, where conditions, having, order, limit, limit per, currency, detail, totals, share, compare, rollup, fill, cumulative, rolling, median | all, plus weighted averages, units, as-of rates, like-for-like comparison, comparison by periods or with a given span | `algebra.ts`, `evaluate.ts`, `sql.ts` |
| definition checks: SQL columns, grain, reads exist, no loops, replacement fits callers | sources checked at the source when defined (columns, keys, histories, braces, programs); a schema that would break a session's question refused unless replaced deliberately | `runtime.ts`, `producers.ts` |
| concepts read sources; programs compose relations in braces | sources are statements, statements on other objects in braces, or programs (declared reads, rows held to the object's grain, decisions and caveats recorded) | `producers.ts` |
| discovery: catalog, members | node, paths, exact find, catalog, member search at the source with typing mistakes and ambiguity | `discovery.ts` |
| answer contract: views, narration citing cells, next steps | the same; datasets are recorded answers and next steps are checked moves | `answers.ts` |
| trace | from memory, with the calls made for an answer | `answers.ts` |
| dialects: SQLite, DuckDB, Oracle/SuiteQL, SQL Server; manager adapter | the same four; manager query, dialects and inspection over HTTP | `dialects.ts`, `manager.ts` |

Not yet, and said plainly:

- **SQL Server is not run against a live source**; its statements are checked by shape only, and it does not compile
  "everything under" (a recursive query cannot sit inside another there). SuiteQL runs live on NetSuite.
- **Member searches are not recorded** as calls.
- **Answer programs lack four things the old programs had**: parameters with learned defaults (`assume`), spans
  resolved in the program (`span`), expectations (`expectation`) and who is asking (`who`). Composition and reuse of
  programs are out by choice: one whole program per answer, kept in its session.
- **A conversation's state for program answers is thin**: the program's name and parameters, not the coordinates its
  questions share; follow-ups are carried by the agent rather than applied to a recorded state.
- **The strategy graph** — an agent's decisions while answering, stored and reused only in the same situation (same state,
  same canonical question) — is designed for, not built: calls carry their parent, canonical question and session state.
- **Schema definitions are stored whole** (as JSON in SQLite), not as node and arrow tables.

## 16. Experiment

1. **Textbook cases**, each a small schema with simulated data and a known correct result: the fan trap, the chasm trap,
   role-playing dimensions, a non-strict hierarchy, a person who changed pillar mid-month (`as-of`), a stock rolled up
   over time, a ratio across two facts, money in two currencies, budget versions, a manager hierarchy.
2. **Fusion5 Scenario 1** on simulated data: revenue by pillar and month, against budget, drill up and down, slices, a
   state walked through messages, refused moves, an intervention on a rate and on an arrow, a counterfactual.
3. **Reading questions**: worded variants reaching the same canonical form; a misread term repaired from its
   neighbourhood.
