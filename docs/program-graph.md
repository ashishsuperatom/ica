# Program Graph

Status: draft, 2026-09-14, revised the same day. Written to be edited. Where this document says **Open**, the reasoning is
not settled, or it is not yet clear the author has understood the intent.

Each section separates three things: what has been **decided**, the **reasoning** behind it, and what is
still **open**.

---

## 1. The problem

We have tried two ways of turning a question into an answer. Both broke for the same underlying reason.

### 1.1 Intent programs

The first instinct was one program per intent:

    INTENT  ->  JS({ customerName: "ABC PTY LTD", targetDate: "NOV 2026" })

The program is named after the question and its parameters are the question's blanks. Inside it is all the
logic needed to answer that one question.

It fails in three ways.

- **No drill-down.** A variation of the question — another cut, a finer grain, a different period — is a
  different program. The number of programs grows without bound.
- **No single fix.** When a user says part of the logic is wrong, that logic lives inside every program
  that needed it. There is nowhere single to correct it.
- **So programs stopped being reusable**, and we gave up on reusing them.

### 1.2 Copied concepts

The second attempt made the *definition* single — a concept, stored once — and let every program read it
and write its own version. It failed differently.

Evidence, from one conversation: six programs, five of them counting bookings, each with its own retyped
SQL, none carrying the concept's invariants. And there was no mechanism for a program to call a concept at
all; the only reuse was an agent reading one and retyping it.

A concept being stored once did not make it *used* once.

### 1.3 The lesson

Knowledge an agent reads is not a constraint. Only something the engine executes — and routes every use
through — is.

---

## 2. The idea

### Decided

- **Everything is a program.** A program is a node in a directed acyclic graph, called with parameters.
- **Everything is JavaScript.** There is no second kind of node.
  - Some programs contain all their logic within them.
  - Some programs mostly wrap others, composing them with parameters — in effect an AST with parameters —
    but they are still ordinary programs.
- **Fundamental programs are tagged as concepts.** Concepts are the raw semantic model.
- **Everything composes.**
- **The body is unconstrained**, but it keeps a structure maintained by soft prompt: conventions the
  authoring agent follows, not a language that restricts it.
- **JavaScript and SQL are kept deliberately.** LLMs write expressive programs in them far better than in
  any DSL, and programs have often expressed questions the system was never designed for. That power is not
  given up.
- **Better agents give better results for free.** As the authoring agent improves and the prompt improves,
  the graph improves, without redesign.
- **Programs are discoverable.** We — through the coding agent — write a program the first time we meet
  the need for it.
- **One program per idea.** Every use references it. If it is wrong, it is fixed once.
- **Programs are immutable.** A change is a new program, identified by hash.
- **Programs have memory**: what was passed in, what ran, what came out, and a compressed summary of the
  distribution of everything that has passed through.
- **Correction propagates.** If ten programs use a calculation and all ten are wrong, the user's correction
  is applied once, and the next time any of those ten questions is asked, it is answered correctly.
- **We design our own model**, shaped so that LLM agents write it well and our cases are well represented.
  We are not adopting Apache Ossie or another standard at this stage.

### Reasoning

The intent-program design had the right *unit* — a JavaScript program — and the wrong *shape*: programs
were leaves named after questions. This design keeps the unit and changes the shape: programs are nodes that
call nodes, named after ideas rather than questions, and a question is a call into the graph.

---

## 3. Requirements

These are the tests the design must pass.

- **R1 Composition.** Any program can be built from other programs.
- **R2 Expressiveness.** Any user intent can be expressed; better agents produce better results.
- **R3 A checkable calculus.** Whole classes of mistake are impossible by construction.
- **R4 Discovery.** Programs can be found, and are authored on first encounter.
- **R5 Single definition.** One program per idea, referenced everywhere, fixed once.
- **R6 Immutability.** Programs are identified by the hash of their content.
- **R7 Memory.** Raw and compressed memory, used to revisit past decisions as the data shifts.
- **R8 Beyond reporting.** Drill and slice, counterfactuals, ad-hoc rules, several questions at once,
  causal analysis, decisions, and strategies that learn from previous attempts and failures.

---

## 4. Anatomy of a program

### Reasoning

Every program has four parts.

1. **Hash.** Identity is content. A changed body is a different program.
2. **Body.** JavaScript and SQL, unconstrained, following soft-prompt conventions.
3. **Contract.** What the program reads, what it returns, and what must hold. The engine checks and
   composes against the contract, never against the body.
4. **Memory.** Its calls, and summaries of what passed through.

A concept is a program that reads a data source directly. Every other program reads programs.

**Proposed rule:** only concepts may read a data source. It is what makes R5 enforceable rather than
hoped for — a program that needs revenue cannot retype a revenue query, because it has no data access; it
can only call the program that defines revenue.

### Open

- Is "only concepts read sources" the right rule, or too strict? A one-off exploratory query, or a check
  that something exists before deciding, may want direct access.
- What exactly is in the contract. A first proposal is in section 5 and section 8.

---

## 5. Parameters

### The problem

If a program's parameters are designed for questions q1 to q5 and q6 arrives needing one more, the
parameter list grows. The first instinct was to split: a wrapper takes q1 to q6, passes q1 to q5 to one
program and q6 to another.

That instinct is right. The proposal below makes it the default mechanism rather than something written by
hand each time.

### Reasoning: three kinds of input

**Coordinates — where in the data.** Measures, dimensions, filters and time. This vocabulary is fixed and
never grows. Drill, slice, roll-up and pivot are formal operators over it (Gray et al., 1997). A program that
returns dimensioned data accepts coordinates, so a drill-down is a different call, never a different
program.

**Assumptions — under what beliefs.** Named, typed values with units, ranges and defaults, such as a target
utilisation or a standard working week. They are **looked up by name from a context that flows down the
graph**, not passed position by position. Each program declares only the assumptions it reads.

This dissolves the q6 problem. A new program declares q6 and reads it; every caller keeps passing the same
context; programs that do not need q6 never see it. The technical name is row polymorphism, or extensible
records: *I need at least these fields; pass along the rest.*

**Interventions — what if, for this request only.** Override a program's output, swap it for a compatible
alternative, or supply a one-off rule. An ad-hoc rule the user gives "just for this instant, not to be
saved" is an intervention. It is recorded with the answer and never enters the graph. This is Pearl's
do-operator. Algebraic effects (Plotkin and Pretnar, 2009) are the cleanest mechanism: a program asks for a
value, a handler supplies it, and a counterfactual is simply a different handler.

A request with several questions, an assumption, and two interventions:

    {
      ask: [
        { measure: 'capacity gap',    by: ['pillar'], time: '2026-Q4', where: { subsidiary: 'NZ' } },
        { measure: 'revenue per FTE', by: ['pillar'], time: '2026-Q3' },
      ],
      assume:    { targetUtilisation: 0.85 },
      intervene: [
        { adjust: 'fte', where: { pillar: 'CEC' }, add: 3 },      // three hypothetical hires
        { replace: 'charge-out rate', with: 'planned rate' },     // a different mechanism
      ],
    }

Several questions at once are several entries in `ask`; the engine plans one graph and computes shared
programs once.

### Open

- Not every program returns dimensioned data. A lookup, a check, or a decision may not fit coordinates
  naturally. How those are called is not yet designed.
- Whether coordinates, assumptions and interventions are the right split, or whether the user's intent
  differs.

---

## 6. SQL, JavaScript and composition

### The question

SQL is optimised by the database; JavaScript is not. Joining and looping inside SQL is far faster than
pulling data into JavaScript and looping there. So data should never be loaded into JavaScript to do work
that SQL can and should do.

But real questions also need JavaScript between queries: run a small query to check something exists, make
a decision, then run the next query — rather than one giant SQL statement with joins the answer does not
need.

Does designing programs for composition cost that performance?

### Reasoning

Not necessarily. There are three ways programs can combine, and the design should use each where it fits.

**1. Programs return rows; JavaScript combines them.**
Each program runs its own query and returns results. Cheap and fine *when each result is already aggregated
to the requested coordinates* — a few dozen rows per pillar per month. Wrong when it means pulling raw rows
to join in JavaScript.

**2. Programs return a query, not rows.**
A program can return a relation — a lazy, composable description of a query, which is an AST with
parameters — instead of executing it. A parent program composes relations from several programs into one
statement and runs it once, and the database optimises the join. This is how semantic layers compile
definitions into SQL. We already parse and rewrite SQL with SQLGlot, so composing at the AST level is
feasible.

It has two hard limits:

- all the pieces must be in the same database. A join cannot be pushed across NetSuite and TotalGroup.
- a decision that depends on data cannot live inside a single statement.

**3. Staged execution — the realistic case.**
A program is a JavaScript sequence of stages. Each stage is one composed, optimised query. Between stages,
JavaScript looks at a *small* result and decides what to do next. This is exactly the check-then-decide
pattern described above. Research names for it are staged computation and adaptive query processing.

The rule that follows:

> **Push down everything that does not need a decision. Materialise only to make a decision, or to cross a
> source boundary — and when you do, materialise aggregated results, not raw rows.**

So a complex question cannot become one SQL statement, and should not try to. Decisions come first, sources
differ, and some logic — effective-dated history, forecasting, statistics — does not belong in SQL. But each
stage can still be one query composed from many programs.

An example — capacity gap by pillar next quarter, all on one source:

1. **Compose, one query.** Headcount and leave, composed into available hours by pillar and month.
2. **Decide, one small query.** Does any pillar have no go-lives recorded? If so, use the run-rate forecast
   instead of the pipeline forecast.
3. **Compose, one query.** Forecast demand by pillar and month.
4. **Combine in JavaScript.** Two small aggregated results, subtracted.

A soft-prompt convention follows too: a program returns a relation when it can, and rows only when it has
to.

### Open

- Whether the first slice should support returning relations, or only rows, with relations added once
  composition is proven.
- How a composed relation is explained, since its trace is one query built from several programs.

---

## 7. Correction propagation

### Decided

If a calculation is used by ten programs and all ten are wrong, one correction fixes all ten the next time
any of them runs.

### Reasoning

Immutability and fixing once look contradictory. They are not.

- Programs are immutable, identified by hash.
- **Names** are mutable pointers to hashes, with history. This already exists.
- Programs call other programs **by name**, so the next execution uses whatever the name points to now.
- Every answer records the exact hashes it used.

A correction is then:

1. Write the corrected program. It gets a new hash.
2. Verify it.
3. Repoint the name.

From that moment every future call, by every program, uses the correction. Past answers keep their pinned
hashes, so lineage lists exactly which ones went through the wrong version, and they can be re-run and
compared.

Three conditions must hold for this to be true in practice:

- **The ten must call, not copy.** The rule in section 4 is what guarantees it.
- **The correction must land on the right program.** The execution trace (section 9) is what lets a user,
  or an agent, point at the node that is wrong rather than the answer that looks wrong.
- **A correction that changes the contract must re-check every dependent.** If the fix adds a dimension or
  changes a unit, dependents are re-validated when the name is repointed, and a dependent that no longer fits
  blocks the repoint or is flagged.

When a number must not move — last quarter's board pack — a program pins a hash instead of a name.

Already built and relevant: a concept a person has verified cannot have its name moved by an agent.

---

## 8. What can be checked

### Reasoning

A strict limit first. By Rice's theorem, no checker can decide non-trivial properties of arbitrary programs.
With JavaScript bodies, not every program can be proven correct. What can be done is to make whole classes
of mistake impossible, and to catch the rest in layers.

**Impossible by construction — checked when a program is defined.**

- **Units.** Dimensional analysis as a type system (Kennedy, 1997; F# units of measure). Currency plus hours
  is refused; currency divided by FTE gives currency per FTE.
- **Summarizability.** Lenz and Shoshani (1997) classify measures as **stock** (a headcount — not summable
  over time), **flow** (revenue — summable) and **value per unit** (a price or ratio — never summed, always
  recomputed from its parts). Summing a stock across months is refused. The earlier `point` and `window`
  were a half-formed version of this.
- **Grain.** Grain is a set of keys; functional dependencies show when a join fans out. Kimball's fan and
  chasm traps are the named failures. *Seen here:* charge rows multiplied hours by 1.87.
- **Shared dimensions.** Two programs combine on `pillar` only if they declare the same `pillar` dimension.
  Joining on a name string is refused. *Seen here:* `BillingClient = PartyName`.
- **Dimension history.** Each dimension is read either as it is now or as it was then; mixing them is
  refused. *Seen here:* effective-dated FTE.
- **Time semantics, assumption types and ranges, no cycles,** and access control carried through
  composition.

**Checked every time a program runs.**

- **Contracts** (Meyer's design by contract): the result has the declared shape, one row per coordinate,
  units present.
- **Invariants** the body declares.
- **Property checks** (in the spirit of QuickCheck): for summable measures, the parts add up to the whole on
  sampled coordinates.

**Detected over time, from memory.**

- Results drifting or anomalous against their own history.
- Reconciliation between related programs, such as ledger revenue against invoice revenue.
- A fixed set of known questions replayed whenever a program changes.

**Never checkable.** Whether a body computes what the organisation *means*. That stays with invariants and a
person certifying the program — which is what the `verified` status is for.

### Open

- Which of these belong in the first slice.

---

## 9. Explanation

### Reasoning

Because every number comes from a graph of named programs, the explanation of an answer is its execution
trace, not a story written afterwards:

    "which pillars will be short of capacity next quarter?"
    -> capacity gap · by pillar · 2026-Q4

    capacity gap v4                  by pillar · 2026-Q4 · targetUtilisation 0.8 (default)
    ├─ forecast billable hours v2    by pillar · 2026-Q4
    │  ├─ projects going live v7     2026-10-01 to 2026-12-31
    │  └─ charge-out rate v3         billed rates, not planned
    └─ available hours v5            by pillar · 2026-Q4
       └─ fte v9                     by pillar · month, rolled to quarter by LAST
    invariants held 11 · caveats 3 · data as of 2026-09-14 06:00

A model can turn this into prose, but the facts come from what actually ran, so it cannot misdescribe the
calculation.

Remaining risks, stated honestly:

- **Translation.** A question can be mapped to the wrong program. Show the reading first — "I read this as
  gross margin by pillar" — so it can be corrected.
- **Coverage.** A question outside the graph still needs a program authored.
- **Data quality.** Correct logic over wrong data.
- **Forecasts** are assumptions and must say so.

---

## 10. Memory

### Decided

Programs have memory. The purpose, in the user's example: a program deciding whether to expand a branch beyond
three production units computes at time t1 that demand is at or below capacity. Without memory, the program is
stuck with that decision. With memory, it can later see that demand has grown past capacity. We build programs
for a future we have not seen, which is impossible to do in advance; durable memory of past data is how new
decisions get made as the distribution changes.

For now, memory is:

- **Input and output.** Every run keeps what was passed in and what came out.
- **Compression after every run.** A compression step runs after each run. It groups similar results within a
  time window and keeps a statistical distribution of them.

The rest of memory — retention, what it may hold, richer tiers — is decided later.

### Reasoning

What counts as **similar** needs a precise definition, or the distribution mixes things that should never be
compared. A reasonable first rule: the same program, the same coordinates apart from time, and the same
assumptions.

The program's **hash** belongs in that rule too. When a program is corrected it gets a new hash, and its results
may legitimately change. If the distribution does not separate the old hash from the new one, a correction
looks exactly like the world changing. The same applies to the data's freshness when a source is restated.

Compressed summaries have a well-developed science and can be kept in bounded space: quantiles (t-digest),
distinct counts (HyperLogLog), frequencies (Count-Min), and rolling mean and variance.

In the production example, a decision program also records **the boundary its choice depended on**, so that
memory can say when the evidence has crossed it. Decision theory names the two ideas involved: value of
information (Howard, 1966) and real options (Dixit and Pindyck, 1994).

### Open

- Retention, and what memory may hold.
- The exact rule for "similar", and the size of the time window.
- Whether the distribution is kept per coordinate, and how finely.

---

## 11. Expectations

### Decided

**Every program has an expectation of its output.**

When a result falls outside that expectation, more analysis is done to tell two things apart:

- a **genuine value** that belongs within the distribution, or
- **the world has changed.**

From that, the system can:

- **highlight it to the user**, or
- **enrich the programs downstream** — add more branches to the DAG so the graph becomes richer and can
  account for what it just saw.

### Reasoning

**Where an expectation comes from.** Three sources, used together:

- **Declared** by whoever writes the program — a prior. Utilisation lies between 0 and 1 and usually between 0.5
  and 0.9.
- **Learned** from memory — the empirical distribution of this program's past results.
- **Derived** from the programs it calls. If both inputs of a ratio are within their expectations, the ratio's
  range follows from theirs. This is uncertainty propagation.

A declared expectation is what a new program starts with; a learned one replaces it as memory accumulates.

**An expectation must be conditioned on the coordinates.** Utilisation in one pillar is not utilisation in
another; December is not March. An expectation that ignores the pillar, or the season, makes everything look
unusual.

**One result cannot tell a rare value from a changed world. A window can.** A single point outside the
expectation is most often a tail value or an error. A sustained shift across several runs is a change. This is
the distinction statistical process control has made for a century: a single point beyond the control limits
against run rules that detect a sustained shift (Shewhart control charts, the Western Electric rules), and in
modern terms, anomaly detection against changepoint detection (CUSUM, ADWIN).

**Triage, in order.**

1. **Is it an error?** Check the program's contract and invariants, and the freshness and completeness of its
   data. A duplicated join or a partial load looks exactly like a surprise.
2. **Where did it start?** Walk down the graph to the deepest program whose result is also outside its own
   expectation. That is where the surprise originates; everything above it merely inherited it. This is one of
   the strongest things a graph of programs with expectations can do, and a single monolithic program cannot.
3. **Rare or changed?** Look at the window: an isolated point, or a shift.

**What follows.**

- **An error** is fixed at the program where it started, once (section 7).
- **A rare value** is shown with context: how unusual, and against what.
- **A changed world** is highlighted, the learned expectation is updated, and decisions whose boundaries it
  crosses are reopened (section 10).
- **Something the graph cannot explain** becomes a proposal to enrich it: a new branch — a dimension that
  separates the unusual cases, or a mechanism program that explains them.

That last point needs care. Programs are immutable, so the graph is never changed in place by an alarm. Adding a
branch goes through the same path as any new program: a typed hole, a program written to fill it, checked, run
and certified. The alarm proposes; it does not rewrite.

### Open

- How an expectation is written when a program is authored.
- How wide an expectation is before a result counts as outside it, and how many results make a shift.
- Who sees a highlight, and when.
- Whether enrichment is proposed to a person or authored automatically for review.

---

## 12. Counterfactuals, causal analysis and decisions

### Reasoning

Pearl's ladder of causation is the frame: association, then intervention, then counterfactual.

The distinction that matters is between two kinds of program:

- **Definitional** programs are identities. Revenue per FTE *is* revenue divided by FTE. An intervention on
  one is exact.
- **Mechanism** programs encode a belief about the world — for example that three hires raise billable
  hours by some amount. An intervention on one is only as good as that belief.

So a graph of calculations is not automatically a causal graph. Mechanism programs must be marked, their
assumptions stated, and those assumptions tested against memory: did hiring in the past actually raise
billable hours the way the mechanism claims?

A **decision program** records the options as values of levers, the objective, the constraints, the chosen
option, the expected outcome, and the boundary at which the choice would flip.

### Open

- How mechanism programs are distinguished from definitional ones in practice.

---

## 13. Analyses and strategies

### Decided

Causal analysis is mostly a program that calls several base programs to get data and does a lot of
conditional reasoning — traditionally an agent's work. It should be encoded so that the next time a similar
analysis is asked, with changed data, it runs programmatically. Because each program has memory, a strategy
can remember previous attempts and failures, and be careful.

### Reasoning

An analysis is a program whose body chooses which programs to call next based on what it finds. It is still
hashed, still has a contract, still has memory. Once written, it re-runs on new data without an agent,
taking whichever branches the data now dictates.

Two established ideas make it learn:

- **Case-based reasoning** (Aamodt and Plaza, 1994): retrieve, reuse, revise, retain. Memory holds past
  analyses, including dead ends. A new question starts from what worked and avoids what did not.
- **Library learning.** DreamCoder (Ellis et al., 2021) solves tasks with a library, then in a *sleep* phase
  compresses recurring parts of solutions into new library functions. This is System 4 as `CLAUDE.md`
  describes it, with a working precedent.

One hard requirement: **outcomes**. Without recording whether an analysis or decision turned out right,
memory can detect that the world changed but cannot learn which strategy is better.

### Open

- Where outcomes are recorded, and by whom.

---

## 14. Naming and discovery

### Decided

A program's name is decided by the user's question, the data's table and field names, and the common
business names the agent chooses. Program names are the same as measure or semantic-model names.

A program is created with one name. When the same idea later arrives under another name, that name is
pointed at the same program.

### Reasoning

A name is a pointer, so one program can carry several names without duplicating anything.

Discovery should work by name and meaning, and also by **what a program consumes and produces** — in the way
Hoogle finds Haskell functions by type. "Something that returns demand by branch by month" is that kind of
search.

The authoring loop:

1. A question becomes a request over existing programs.
2. Where the graph cannot answer it, the checker reports a **typed hole**: what is missing, and the exact
   contract it must meet.
3. The agent writes a program to fill it.
4. It is checked, run, certified and named.

A better agent fills holes faster (R2). The floor on correctness is set by the checker and contracts, not by
the agent (R3).

---

## 15. Limits

- Bodies cannot be proven correct.
- A graph of calculations is not a causal graph without marked, tested mechanisms.
- JavaScript is not optimised; SQL inside bodies must aggregate, and the datasource manager caps a query at
  5,000 rows.
- Memory costs storage and raises retention and privacy questions.
- Shared dimensions and ownership of definitions are organisational work.
- Learning strategies requires recorded outcomes.
- Expectations raise false alarms until they are conditioned well enough, and learned from enough history.

---

## 16. What exists already

Built on branch `concepts/runnable`:

- content-addressed concepts, a name index, bitemporal history
- one metadata schema, validated when saved
- `verify`, `caveat` and `decide` in the program context
- per-conversation working directories and `./commit`
- structural signatures and value clustering, observation only
- the `verified` status, and verified names protected from agents

Missing:

- programs calling programs through the engine, by name
- the request: coordinates, assumptions from context, interventions
- dimensions as objects, grain as keys, stock / flow / value per unit, unit algebra
- the definition-time checker and typed holes
- returning relations, and staged execution
- input and output memory, compression after each run, and the distributions
- expectations, triage of results outside them, and change detection
- decision programs, mechanism marking, outcome records

---

## 17. First slice: a simulation

### Decided

Take one idea and build the basics end to end, to test whether the design works before refining the
concepts:

1. programs, and slice / drill-down
2. composition
3. intervention
4. causal analysis
5. counterfactual
6. decision making

Then refine.

### Proposal

**Domain: capacity and utilisation, on the local `F5NETSUITE` data.** It is the one domain where every
step above arises naturally, and it is the user's own production-capacity example in another form. Most of
its concepts already exist as runnable concepts: FTE, weekly utilisation against target, projects going
live, charge-out rate, revenue forecast from time.

Steps, each with what it proves:

- **S1 Programs.** Define a program, hash it, name it, call it through the engine by name, record tier-one
  memory. *Proves R6, and the base of R1 and R7.*
- **S2 Slice and drill.** Two concept programs — FTE and utilised hours — answering by pillar, then by
  employee, then by month, with FTE refused when summed over months. *Proves coordinates and
  summarizability.*
- **S3 Composition.** Utilisation as utilised hours over available hours; one wrapper program that stages a
  check before its main query. *Proves R1 and staged execution.*
- **S4 Correction.** A deliberately wrong concept used by several programs; fix it once; every one is
  correct on its next run; lineage lists the affected past answers. *Proves R5.*
- **S5 Intervention.** A standard-week assumption; "three hires in one pillar"; an ad-hoc rule for one
  request only. *Proves assumptions and interventions.*
- **S6 Counterfactual.** "What would last quarter's utilisation have been with those three hires, or with a
  different target?" *Proves the do-operator over definitional programs.*
- **S7 Expectation and causal analysis.** Replay history so utilisation has a learned expectation; a later
  result falls outside it; triage walks the graph to the program where the surprise starts. "Why did
  utilisation fall in this pillar?" then runs as a program that branches — headcount, leave, fewer billable
  projects, rate — with its path and result held in memory. *Proves expectations and analyses as programs.*
- **S8 Decision.** "Should this pillar hire next quarter?" as a decision program with a recorded boundary;
  replay a later period that crosses it and show the decision reopening. *Proves R7's purpose.*

Out of scope for the slice: the authoring agent (programs are written by us, with an agent's help), the
user interface, deployment, and access control.

### Open

- Confirm the domain.
- Whether programs in the slice return relations, or rows only.

---

## 18. Open questions

1. Is "only concepts read data sources" the right rule?
2. How are programs that do not return dimensioned data called?
3. Who certifies a program?
4. How long is memory kept, and what may it hold?
5. Where are outcomes recorded, and by whom?
6. Who owns the shared dimensions?
7. How are mechanism programs told apart from definitional ones?
8. What counts as similar when results are compressed, and over what window?
9. How is an expectation declared, and when is a result outside it?
10. When a result is outside its expectation, who is told, and is enrichment proposed or authored?

---

## References

- Aamodt, A. and Plaza, E. *Case-Based Reasoning: Foundational Issues, Methodological Variations, and System
  Approaches.* AI Communications, 1994.
- Acar, U. *Self-Adjusting Computation.* PhD thesis, Carnegie Mellon University, 2005.
- Bifet, A. and Gavaldà, R. *Learning from Time-Changing Data with Adaptive Windowing.* SIAM SDM, 2007.
- Claessen, K. and Hughes, J. *QuickCheck: A Lightweight Tool for Random Testing of Haskell Programs.*
  ICFP, 2000.
- Cormode, G. and Muthukrishnan, S. *An Improved Data Stream Summary: The Count-Min Sketch.* Journal of
  Algorithms, 2005.
- Dixit, A. and Pindyck, R. *Investment under Uncertainty.* Princeton University Press, 1994.
- Dunning, T. and Ertl, O. *Computing Extremely Accurate Quantiles Using t-Digests.* 2019.
- Ellis, K. et al. *DreamCoder: Bootstrapping Inductive Program Synthesis with Wake-Sleep Library Learning.*
  PLDI, 2021.
- Flajolet, P. et al. *HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm.*
  AofA, 2007.
- Gama, J. et al. *A Survey on Concept Drift Adaptation.* ACM Computing Surveys, 2014.
- Gray, J. et al. *Data Cube: A Relational Aggregation Operator Generalizing Group-By, Cross-Tab, and
  Sub-Totals.* Data Mining and Knowledge Discovery, 1997.
- Howard, R. *Information Value Theory.* IEEE Transactions on Systems Science and Cybernetics, 1966.
- Kennedy, A. *Relational Parametricity and Units of Measure.* POPL, 1997.
- Kimball, R. and Ross, M. *The Data Warehouse Toolkit.*
- Lenz, H.-J. and Shoshani, A. *Summarizability in OLAP and Statistical Data Bases.* SSDBM, 1997.
- Meyer, B. *Object-Oriented Software Construction* (design by contract).
- Mokhov, A., Mitchell, N. and Peyton Jones, S. *Build Systems à la Carte.* ICFP, 2018.
- Page, E. S. *Continuous Inspection Schemes.* Biometrika, 1954.
- Pearl, J. *Causality.* Cambridge University Press, 2000.
- Plotkin, G. and Pretnar, M. *Handlers of Algebraic Effects.* ESOP, 2009.
- Shewhart, W. A. *Economic Control of Quality of Manufactured Product.* 1931.
- Rice, H. G. *Classes of Recursively Enumerable Sets and Their Decision Problems.* 1953.
- W3C. *PROV-O: The PROV Ontology.* 2013.
- Western Electric. *Statistical Quality Control Handbook.* 1956.
- The Unison programming language — content-addressed code.
