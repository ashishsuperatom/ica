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

### Decided

- **Most questions span several databases**, and many must **resolve something before the next query can
  run** — a customer named with a spelling mistake goes through a resolver that searches and returns an id, and
  only then can the real query run. So a question is not a chain of queries passed along until one final SQL
  call. It is staged.
- **Composition still needs programs to be able to return a query**, so a later program can extend it.

### A worked example

A program does one of two things: it **runs** something and returns a value, or it **returns a relation** —
a query not yet run — that another program can extend. Resolution and decisions are the first kind;
definitions and slices are the second.

A concept returns a relation. It is the definition, written once:

    // concept · invoiced revenue            (returns a relation; nothing runs)
    export default (ctx) =>
      ctx.from('F5NETSUITE', 'transaction t')
         .where(`t.type = 'CustInvc' AND t.voided = 'F'`)
         .dimension('customer', 't.entity')
         .dimension('month',    `TO_CHAR(t.trandate, 'YYYY-MM')`, { time: 'month' })
         .measure('revenue',    'SUM(TO_NUMBER(t.total))', { unit: 'AUD', kind: 'flow' })

A resolver runs, because it is a decision point, and returns a value:

    // program · resolve customer            (runs now; returns an id)
    export default async (ctx, { name }) => {
      const hits = await ctx.run(
        ctx.from('F5NETSUITE', 'customer c')
           .select({ id: 'c.id', name: 'c.companyname' })
           .whereSimilar('c.companyname', name)
           .limit(5))
      ctx.decide('one customer matches', hits.length === 1, `${hits.length} candidates for "${name}"`)
      return hits[0].id
    }

A composite stages them. The first stage runs; the second is still a relation:

    // program · revenue for a customer
    export default async (ctx, { customerName, period }) => {
      const id = await ctx.call('resolve customer', { name: customerName })   // stage 1 — runs
      return ctx.relation('invoiced revenue')                                  // stage 2 — still lazy
                .where({ customer: id })
                .by(['month'])
                .during(period)
    }

When that relation runs, the concept's definition and the composite's additions compile into one statement:

    SELECT TO_CHAR(t.trandate, 'YYYY-MM') AS month, SUM(TO_NUMBER(t.total)) AS revenue
    FROM transaction t
    WHERE t.type = 'CustInvc' AND t.voided = 'F'        -- from the concept, never retyped
      AND t.entity = :customer                          -- from stage 1
      AND t.trandate >= :from AND t.trandate < :to      -- from the period
    GROUP BY TO_CHAR(t.trandate, 'YYYY-MM')

The composite extends the concept's query instead of rewriting it, and the database still does the work.

Across two databases it cannot be one statement:

    // program · customer health — revenue from NetSuite, late deliveries from TotalGroup
    export default async (ctx, { customerName, period }) => {
      const nsId = await ctx.call('resolve customer', { name: customerName })   // NetSuite's key
      const tgId = await ctx.call('resolve party',    { name: customerName })   // TotalGroup's key
      const revenue = ctx.relation('invoiced revenue').where({ customer: nsId }).by(['month']).during(period)
      const late    = ctx.relation('late deliveries').where({ party: tgId }).by(['month']).during(period)
      const [a, b] = await Promise.all([ctx.run(revenue), ctx.run(late)])       // each side pushed down fully
      return ctx.join(['month'], a, b)                                          // twelve rows each, joined here
    }

Each side is still pushed down completely and aggregated to the shared dimension before reaching JavaScript.
When one side is small, its ids can be pushed into the other database as an `IN (…)` filter — what federated
query engines call a bind join.

### Open

- How a composed relation is explained, since its trace is one query built from several programs.
- How identity is matched across databases, as in the two resolvers above.

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
- **Recent memory in full, the far past compressed.** Both are needed to learn what affects what. Without the
  long history, a conclusion is drawn from too little; without recent detail, the cause of a change cannot be
  seen.

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

### Decided

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

The slice is built and run by hand, without the authoring agent or ICA, so that what works and what is
missing shows up fast. Integration with ICA comes afterwards. Also out of scope: the user interface,
deployment, and access control.

### Findings

**S1 — programs** (`vm/packages/graph`, `examples/s1-programs.mts`). Works on real data: programs defined
from files and identified by hash; a question staged through a resolver that tolerates a spelling mistake
and refuses to guess between two pillars both named `MWP`; every call remembered and traced from memory;
the contract enforced at definition and at call; and a correction to `active headcount` — system accounts
and placeholders are not people — reaching `pillar headcount` without that program changing at all
(OH 130 → 128, the company 1,159 → 1,155), with the calls that went through the wrong version listed.

What S1 exposed:

- **A program's hash no longer determines its answer.** `pillar headcount` kept its hash and its answer
  changed, because a program it calls was corrected. Reproducing an answer therefore needs every hash in
  its call tree, not only the top one. Memory records them; nothing yet replays from them.
- **Outputs are bespoke objects.** `{ pillar, headcount }` cannot be drilled or combined. This is what S2
  must replace with dimensioned results.
- **`pillarId` is a positional parameter** — the q6 problem in miniature. S2 replaces it with coordinates.
- **`returns: value` says nothing about shape.** The contract needs the output's shape to be checkable.
- **Repointing does not check that the new program still fits its callers.** A replacement that returned
  rows instead of a value would break every caller at run time.
- **Past calls are listed, not re-run.** Replay after a correction is not built.
- **Resolution fetched all 31 pillars and matched in JavaScript.** Right for a short list; a customer list
  needs the search pushed into SQL.

**S2 — slice and drill** (`examples/s2-drill.mts`). Works on real data. Two concepts, `fte` and `utilised
hours`, return relations; every question is coordinates asked of the same two programs, and none needed a new
program.

- FTE by pillar as at 31 August: 1,159 people, 1,102 FTE, with the split checked against the whole.
- The same stock by month across Q3, read as at each month-end.
- FTE for Q3 with no rollup **refused**; with `last` and with `average` answered.
- Utilised hours by pillar for Q3 (387,914 h), drilled into CEC by employee, then by employee and month — the
  parts summing to the whole at every level.
- Refused: a flow with no time and a measure with no unit at definition; a flow asked at an instant; an unknown
  dimension or filter; and a result the source capped at 5,000 rows, instead of showing it short.

The data itself disagreed about who is employed: 1,155 by the active flag, 1,166 by hire and release date,
1,173 by record creation, with 18 people marked inactive and no release date. The active flag cannot answer a
past date, so the stock uses hire to release date, and says so.

What S2 exposed:

- **Caveats are static text.** "People marked inactive with no release date still count" should say *how
  many*; a relation has no way to compute a caveat.
- **`pillar` is read as it is today** for every past month, so CEC shows the same 150 people across the whole
  quarter. Correct as-at history needs the effective-dated pillar changes.
- **The average rollup is not checked** against a whole the way a single statement is.
- **Queries are slow** — up to 13 seconds for hours by pillar over a quarter — and the same statement is often
  asked twice.
- **"Today" is taken in UTC**, so a reading on the 14th local time was labelled the 13th.
- **Mixing a flow and a stock** could not be exercised: each concept holds one kind. That meeting happens in
  composition, S3.

Programs in the slice can both run and return values, and return relations for others to extend.

### Decided

**A concept is plain SQL; its shape is its interface.** The relation builder from S2 was a small query
language, and it would have stood between a concept and the SQL a source runs best — a NetSuite-specific form,
or a workaround for a bug in one engine. It is gone. A concept's body returns the SQL for one reading, at its
finest grain (one row per employee; one row per time entry), called with `{ asAt }` for a stock or
`{ from, to }` for a flow. The contract's `shape` names which output columns are dimensions, which are
measures and how each aggregates, and which is time. The engine wraps the SQL:

    SELECT <dimensions>, <aggregates> FROM ( <the concept's SQL> ) t WHERE <filters> GROUP BY <dimensions>

so slicing, filtering and bounding the span never depend on the body having done them. The body also receives
the filters, and may use them to read less. At definition the SQL is run once, counting every column the shape
names: a declared column the SQL does not produce is refused then. (NetSuite does not check the columns of a
query it can see returns nothing, so the probe is an aggregate, not `WHERE 1 = 0`.) S2 re-ran with the same
numbers.

**Resolution happens mostly at the start of a program**, where typed text becomes ids and everything after is
calculation. It stays callable anywhere, because strategy programs will refer to other program nodes by
unstructured reference.

**S3 — composition** (`examples/s3-composition.mts`). `utilisation` is a program: it reads no data. In
stages it resolves a typed pillar, decides whether the span has ended (and cuts it at today if not), asks
`utilised hours` and `fte` the same coordinates, and divides row by row — a ratio is never added up, and the
total is the ratio of the totals. By pillar, a misspelt pillar, drilled by month and by employee, and a span
still running: one program, parameters only. The ambiguous `MWP` stops at stage one with no query run.

What S3 exposed:

- **`utilised hours` is wrong.** Retail at 135%, people at 180%. `timebill` holds actual (`A`), budgeted
  (`B`) and planned (`P`) time, and the concept sums all three: Brenda Meyer's 903 hours are 473.5 actual. It is
  kept wrong deliberately as the S4 correction — a real mistake, already used by more than one caller.
- **Capacity is sampled, not measured.** FTE averaged over month-ends and FTE per month give 53,821 and 53,828
  available hours for the same quarter. Capacity is a stock integrated over time — person-time — and can be
  computed exactly from hire and release dates. It should be its own concept.
- **The ratio kind exists only in the composite's output.** `kind: 'ratio'` is the third summarizability class
  (value per unit); it should be one declared idea, not a string one program happens to use.
- **Returns `value` hides a dimensioned result.** The contract cannot say the output is a result with columns,
  so nothing can drill into `utilisation` the way it drills into a concept.
- **Joining two results on their split is hand-written** in the program. Every ratio will repeat it.
- **Hours booked where a person had no capacity** (moved pillar, left) appear as rows with no ratio; that is
  the current-pillar problem from S2 surfacing in a number.

### Decided

**A relation can be built on relations, still in SQL.** A program that returns a relation names the relations
it builds on in braces — `SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'` — and the engine puts
each one's SQL in its place, resolved by name at run time. SQL is closed under nesting, so any relation can be
filtered, joined to another relation on the same source, or extended with columns, and the result is again a
relation the engine can slice. The builder gave no composition this does not: a builder relation could only be
extended by adding joins and conditions to the same flat query, which a subquery does too.

What was actually given up, and how each is held:

- **Structure written by the author** (which expression is a key, which is a condition) — now recovered by
  parsing the SQL with the parser the datasource manager already runs, rather than required of whoever writes it.
- **Reaching inside a concept** for a column it does not output. A caller now sees only output columns, so a
  concept exposes what callers need (`billable`). That is the interface doing its job.
- **Flat SQL.** Composition nests. SuiteQL ran the nested form without trouble; if an engine does not, the parser
  can merge subqueries before the statement is sent.
- **Only a concept names a table** is enforced for a relation program by what it may reference in braces, not
  yet by parsing its SQL for base tables. *Not yet built.*

Across sources a single statement is impossible; relations from two sources are combined by a program after each
is aggregated to the shared split.

**A replacement must fit its callers.** Repointing a name is refused when the new program returns something
else, drops a parameter, or — for a relation — drops or moves a dimension or measure, changes a unit or kind, or
moves its time column.

**S4 — correction** (`examples/s4-correction.mts`). `utilised hours` counted Actual, Allocated and Planned time.
Two things were built on it: `utilisation`, a program that calls it, and `billable hours`, a relation whose SQL
contains its SQL. A correction renaming the measure was refused as breaking its callers. The real correction —
actual time only — moved the name; neither caller's hash changed. Memory found the three answers that went
through the wrong version, however deep, and re-ran them:

- utilisation by pillar, Q2: total 75.9% → 38.4%; Retail 135.5% → 66.7%.
- NetSuite by employee: Brenda Meyer 173.6% → 91.1%.
- billable hours by pillar: 202,590 h → 186,003 h.

What S4 exposed:

- **38% company utilisation is now the suspicious number.** Available hours are FTE × 40 × weeks for every
  pillar, overhead pillars and leave included. Whether OH counts toward capacity, and how long a working week is,
  are assumptions — S5.
- **Replay re-runs a request; it does not diff answers.** The comparison was done by the demo, because an
  answer's output has no identity per row that memory could compare.
- **Nothing ran the replay automatically.** Whether a correction should re-run past answers, notify whoever
  asked, or only mark them, is undecided.
- **Inlined relations are recorded as calls with no queries** so lineage finds them. Their SQL is visible only
  inside the parent's statement.

### Decided — what a relation can be asked

The engine must not be weaker than the agent it replaces, which can already write any program. Two things keep
that true. **The escape hatch is always there:** a concept may return rows from any SQL or API call, and a
program may do anything in JavaScript with them; the relation machinery adds checked slicing on top and never
stands in the way. **And the relation vocabulary is audited against the systems that have done this for
years** — Cube, LookML and dbt MetricFlow, and the summarizability work under them — so that a question those
systems answer is not one we refuse for want of thinking of it.

Added, each with a test that runs the generated SQL (`vm/packages/graph/test`, 25 tests on local rows and 4 live
on NetSuite and TotalGroup):

- **Derived measures** — MetricFlow's ratio and derived metrics. `expression` over measure names, e.g.
  `billable / hours`. A ratio is computed per row from its parts and never summed; its parts are checked
  instead. A product or quotient declared additive is refused.
- **Aggregations** — sum, count, count distinct, min, max, average, median. Each is checked against the whole by
  what it allows: a sum's parts add up; a distinct count lies between its largest part and the sum of its parts
  (the old check would have refused a correct distinct count by month); a minimum is its smallest part; an
  average, a median or a ratio is not checked directly. Averaging readings of an average is refused. Median
  where the dialect has one.
- **Time grains** — day, week (Monday), month, quarter, year, labelled identically in Oracle, SQL Server,
  SQLite and JavaScript; checked on leap days, year ends and week boundaries against both live sources. A stock
  is read at each period's end, never after today.
- **Conditions** — equal, any of, none of, ranges, missing values; **having** on measures; **order**, and
  **limit** only with an order, so which rows are kept is the question's choice. Pushed into the statement when
  one statement answers; the result then says it is not checked against the whole.
- **Fill** — periods with no rows appear, zero for an additive measure, unknown for a ratio.
- **Cumulative** — running totals along a grain, reset by year, quarter or month, reading back to the boundary
  so a year-to-date that starts mid-span is right.
- **Sources that are not SQL** — a concept returns rows; the engine queries them in SQLite with the same
  wrapping, the same checks and the same composition.
- **Today is an input** — every call records the day it was answered as of; programs read `ctx.today`, never
  the clock; `replay` asks a past question again as of its own day through what the names point at now.
- **Cycles** — a program that reaches itself through calls, or a relation built on itself, is refused.
- **Identity as text** — dimension members compare as text, so `15` and `'15'` are one member.

Found by the tests: a `having` value was bound after the statement's parameters were gathered, so it reached
the source empty. It would have failed on every database.

### Open — capabilities not yet built

Each can be done today as a program, so none is a refusal; each is still a gap in what the engine checks.

- **Automatic joins between relations** (MetricFlow's entities). Joins are written by hand in a relation
  program. Nothing checks that `pillar` means the same key in two relations — conformed dimensions.
- **Period over period** (MetricFlow's offset window): this quarter against the same quarter last year.
- **Fiscal calendars.** NZ's April–March year, retail 4-4-5 calendars. Grains are calendar grains only.
- **Dimension history as at the time.** `history: 'as-at'` is declared and not yet honoured differently.
- **Conversion and funnel measures**, percentiles other than the median.
- **Time zones.** Dates are calendar dates; a local source's timestamps compare as text.
- **A result from a program cannot be drilled** as a relation can; its contract cannot describe its columns.
- **Combining a local relation with a SQL one** in one statement is refused; a program aggregates each first.
- **Rows from a non-SQL source are all fetched**; bounding them by `when` and `where` is left to the body.
- **Base tables in a relation program's SQL** are not yet parsed for.

### Decided — assumptions and interventions

**An assumption is declared by the program that reads it** (`assumes` in the contract: description, unit,
default) and read by name with `ctx.assume`. Its value comes from the nearest caller that set it, else the
organisation's settings, else the declared default; with none, the call is refused rather than guessed. A
program sets assumptions for everything below it with `ctx.call(name, request, { assume })`. Programs that do not
read an assumption never see it, so a new one never changes a caller's signature. Every call records each
assumption it read, its value, and which of the three it came from.

**An intervention is a change for one request only** — Pearl's do-operator. By program name, anywhere in the
request however deep: `value` replaces what a program returns; `where` leaves rows of a relation out; `add`
adds rows, and for a stock each added member counts from `from` until `to`. A relation's intervention is SQL
around its SQL, so every relation built on it and every coordinate asked of it sees the change. Nothing enters
the graph. The answer carries a `hypothetical` caveat, every call under it records the interventions, and
`replay` repeats the same day, assumptions and interventions.

**S5 — assumptions and interventions** (`examples/s5-assumptions.mts`, 7 tests). On Q2:

- Defaults (40-hour week, every pillar is capacity): 38.4%.
- Illustrative organisation settings (37.5-hour week; OH, Microsoft and Jade not capacity): 48.2%. A caller's
  35-hour week on top: 51.6%. Asked about OH under those settings, the program says it is outside capacity.
- Three hires in NetSuite from 1 April: available hours 53,821 → 55,381 — exactly 3 × 40 × 13 — and
  utilisation 29.8% → 28.9%. Asked again without the intervention: 29.8%.
- A rule for one request, leaving Fusion5 Ltd out of both concepts: 40.5%.

What S5 exposed:

- **SuiteQL refuses a union whose columns differ in type**, so an added person with a text id beside numeric
  ids failed. Dimension columns are now text inside an intervention, matching how the engine compares members.
- **A stock is never read after today**, so "three hires from next month" cannot yet be seen. Forward-looking
  capacity needs a projection, not an as-at reading — S8.
- **Which pillars are capacity is a real organisational fact** that only Fusion5 can supply; the settings used
  here are illustrative. Where organisation settings live, and who may change them, is open.
- **Calendars are built into the engine.** Grains are calendar grains; a fiscal year starting in April, a
  4-4-5 retail calendar, or a country's own quarters cannot be defined. The likely foundation is Kimball's date
  dimension — a calendar as a relation, chosen by an assumption — rather than more grain arithmetic.
- **Comparison is not in the vocabulary.** This period against a past one (Rill's comparison, MetricFlow's
  offset window) is written by hand as two calls and a join. Aligning periods, partial current periods and
  stocks read as at matching dates are universal and easy to get wrong, which argues it belongs in coordinates.
- **A program cannot take a program as a parameter.** A general "compare any measure" program would have to
  declare every relation it might read. Whether contracts allow a parameter that names a program — typed by the
  shape it must have — is a foundational question.
- **The graph is acyclic at creation, not by construction.** A program may only read names that already exist,
  so nothing new can close a loop; but names are mutable, and a replacement can. That is refused when the loop
  runs, not when the replacement is made.

### Decided — the foundation, extended

The test for what belongs in the engine: a capability every analysis needs, whose parts go wrong the same way
every time it is written by hand. Those are built once, checked, and composed from; everything that is a
particular organisation's way of looking is a program on top.

- **Rules chosen by specificity.** An assumption may be given as rules on who is asking (`who.department`) and
  what is read (`pillar`). The most specific rule that applies wins, as in CSS; two equally specific rules that
  disagree are refused. A layer whose rules do not apply passes to the next.
- **Access comes with the request.** Authorization is decided outside this system, per person, and arrives with
  the request as policies by source. The engine passes them to every query; the SQL rewrite applies them by
  replacing each read of a restricted table with that table filtered — correct under outer joins, aliases and
  repeated reads — and refuses a denied table. Replay takes the access of whoever replays, never the recorded one.
- **Calendars are data.** The assumption named `calendar` defines grains: fiscal (a start month; FY2027,
  FY2027-Q1, FY2027-P01) or listed periods (4-4-5, anything). Chosen by rules when it differs by who is asking.
  Labels are computed once, for SQL as a CASE over the span's periods and for JavaScript; checked live.
- **Comparison is in the vocabulary.** `compare` by offset, span or instant; rows aligned by split and by each
  period's place; a running span compared like for like; month ends clamp; one-sided members are zero for an
  amount and unknown otherwise; change and change ratio are columns that can be ordered and limited.
- **Parameters may name programs,** with what the named program must return and have — so one ranking or
  comparing program serves every relation. A loop made this way is refused when it runs.
- **Loops are refused at definition** when a replacement would let a name reach itself.

### Decided — counterfactuals

`engine.counterfactual(callId, change)` asks a recorded question again as of its own day, under its own
assumptions and interventions, twice — as it was and with the change — and returns both and the difference, row
by row. Both sides are recomputed, so a correction made since is not counted as the change's effect. What the
change does not touch is held as it was, and the answer says so.

**S6 — counterfactual** (`examples/s6-counterfactual.mts`, 3 tests). On the recorded Q2 answer (38.4%, 11 of 16
pillars below a 50% target):

- With three more people in NetSuite: NetSuite 29.8% → 28.9%, the company 38.4% → 38.2%; every other pillar
  unchanged.
- On a 37.5-hour week: 38.4% → 40.9%, Retail +4.4 points.
- Against 60% instead of 50%: 11 → 14 pillars below target.
- On an answer given before `utilised hours` was corrected (75.9%): the hires' effect is −0.1 points. Comparing
  the counterfactual with the recorded answer would have claimed −37.7.

What S6 exposed:

- **Nothing responds to a change.** Three more people add capacity and no hours. Whether hours would have risen
  is a mechanism — demand, pipeline, bench time — not a definition, and the graph has no mechanism programs yet.
  This is where the definitional/mechanism distinction of section 12 becomes necessary, and S7 begins it.
- **A counterfactual is only as honest as its held-fixed list,** which today is "everything else". A mechanism
  program would say what responds and by how much.

### Reasoning — layers, and abstraction learned from use

A question is answered at the lowest layer that can say it: coordinates on a relation; a relation built on
relations; a program composing relations; a program naming other programs as parameters. There is no separate
"analytics layer" above the engine: comparison and counterfactual are part of the engine because every analysis
needs them the same way, and a question that combines many filters, measures and comparisons is still one
program calling relations with coordinates.

What should be created as questions recur is not more capability but more **named programs**: the combinations
an organisation keeps asking for — "utilisation against target by pillar, this quarter against last" — become
programs with names from how people ask, so the next agent calls them instead of recomposing them. That is
library learning (DreamCoder's wake–sleep: solve with what exists, then compress recurring solutions into new
library entries) and it is System 4's job: offline, over memory, it finds call trees that recur with the same
shape, proposes the program that captures them, verifies it gives the same answers on the recorded calls, and
names it. *How recurrence is detected and how a proposed abstraction is verified is open — section 21.*

**A user asking for more on an answer** ("also show each person's manager") is a change to the question, not to
the answer's rendering: the agent finds the lowest layer where the addition belongs — a coordinate, a concept
exposing a new column, a relation joining another, the top program — makes that change, and re-asks. The
rendering follows the result's columns. Which layer, and checking the change was right, is open question 11.

---

## 18. What the question does not say, and answers that differ by person

### Proposal — the parts of a question nobody gave

A person gives only part of a question. Only what they give is a parameter of *this* question; everything else
is filled in, and there is more than one place it can come from. In order:

1. **The conversation.** A follow-up keeps what the earlier question settled unless it says otherwise — "and for
   CEC?" keeps the span and the measure.
2. **The person, their groups, the organisation.** A default span, a default target, a preferred calendar —
   rules ranked person over group over global (section 17).
3. **The program's declared default.**
4. **Asking.** A value that matters and has none of the above is a question back, not a guess.

Not every omission is a gap. An omitted split means "not split"; an omitted filter means "all". What must be
filled is what the answer cannot exist without — the span for a flow, the instant for a stock — and what the
program declares as an assumption.

**Every filled value is shown with the answer and where it came from** — "Q2 2026, from your previous
question"; "37.5-hour week, Finance's setting". That is what makes a default safe: the person sees it and can
say otherwise, and memory already records it per call.

### Proposal — a question that asks for more must not grow the program

"Also show each person's manager" is asked once, then "their location", then "their start date". If each is
added to the program or the concept, the concept becomes the union of every question ever asked of it, and the
person who wanted the plain answer gets all of it.

So an addition is never a change to the answer's program. It is a change to *the question*:

- **The manager is a fact about an employee,** not about hours. It lives in its own concept on the employee
  entity — `employee manager`, keyed by employee — however many tables it takes to find.
- **The engine reaches it by the key**, because hours are declared to be *about* employees: entities and joins
  (section 19, missing). A request adds `attributes: ['employee.manager']`; nothing that existed changes.
- **Two people, one program, different columns.** One asks with the manager, one without. The columns someone
  sees by default are a preference — a rule on the person, their group, or everyone — not a version of the
  program.
- **A combination people keep asking for** becomes a named program later, through consolidation (section 17,
  reasoning), and even then the plain question still exists.

This depends on two capabilities not yet built: **entities with joins by key**, and **dimension attributes**.
It is the strongest argument for putting both in the foundation.

### Proposal — a session is a state, and a follow-up is a transition

The first question in a session creates a **state**: which program answers it, and the whole request — coordinates,
attributes, assumptions, interventions, who is asking, and the day it is answered as of. Every follow-up changes
that state, and the engine runs the program on the new state. Starting over is a new session, or clearing the state.

It is the architecture of Elm and Redux — a state, messages, and an update — and of event sourcing: the session
keeps the sequence of transitions, and the state is what they add up to. Nothing new is needed underneath: a
state is exactly what memory already records for a call, and `call`, `replay` and `counterfactual` already run
one.

What follows from it:

- **Transitions are typed, and checked before anything runs.** Set a span; add a measure, a split or an
  attribute; set an assumption (a weight, a target); add or remove an intervention; change the program while
  keeping what still applies; reset. A transition the program's contract cannot accept is refused as a
  transition, the way coordinates are refused today.
- **The agent's usual job becomes translating a message into a transition** — small, inspectable and checkable
  — rather than writing a program. A program is written only when a transition needs one that does not exist.
  This is the most direct answer yet to verifying what the agent built (open question 11).
- **A session is a tree, not a line.** "What if the environmental weight were higher?" forks the state; two
  branches can be shown side by side, and their difference is a counterfactual between two states.
- **The day is part of the state.** Answers do not shift under the person mid-session; refreshing is itself a
  transition.
- **Rerunning is cheap where the state did not change.** The cache already skips repeated statements; later,
  only the calls whose inputs changed need recomputing (self-adjusting computation, Acar 2005).
- **The display follows the state and the result.** The UI engine renders the result's columns and knows what
  the last transition changed; narration is written from the result and that change.
- **Decisions use the same shape.** In procurement, the weights on price, delivery and environmental impact are
  assumptions in the state; an optimisation engine is a source like any other, with its own inputs and outputs;
  changing a weight is a transition and the recommendation is re-run.

*Open: how a message is classified as a transition of the current state or the start of a new one; how much of
a changed program's state carries over; how branches are named and shown.*

---

## 19. What is missing, compared with systems that exist

A catalogue, to be taken one item at a time: kept, deferred, or rejected. **Us** is ✗ missing or ◐ partial.
Named systems are examples of where the capability exists: Rill, Cube, dbt and MetricFlow, Snowflake, Metabase,
Looker. Section 20 covers what is beyond analysis.

### 19.1 Query vocabulary

| Capability | Us | Where it exists |
|---|---|---|
| Pivot — rows by columns | ✗ long rows only | Rill, Metabase, Looker |
| Subtotals and grand totals, correct per measure kind (a ratio or distinct count is not summed) | ✗ | Rill, Looker, Metabase, Cube |
| Percent of total, share of parent | ✗ | Rill, Looker, Metabase, Cube |
| Top N within each group; rank; row number | ✗ global top N only | Looker, Metabase, Cube |
| An "other" row after a top N | ✗ | Rill, Looker |
| Rolling windows — 7-day average, trailing 12 months | ✗ running totals only | Cube, MetricFlow, Rill |
| Relative dates — last 30 days, quarter to date, previous complete month | ✗ | Cube, Metabase, Rill, Looker |
| Time zones | ✗ | Cube, Rill, Looker, Snowflake |
| Several time columns in one relation — ordered, shipped | ✗ one only | Cube, LookML, MetricFlow |
| Text conditions — contains, starts with, pattern | ✗ | all |
| Segments — named, reusable filters | ✗ | Cube, Metabase, LookML |
| Filtered measures — hours where billable, as a measure | ◐ via a relation program | Cube, LookML, MetricFlow |
| Binning a number into bands | ✗ | Metabase, Looker, Rill |
| Percentiles beyond the median; approximate distinct counts | ◐ median only | Snowflake, Cube, Rill |
| Funnels — conversion between events | ✗ | MetricFlow |
| Cohorts and retention | ✗ | Metabase, Looker, Rill |
| Last value per key over time — a balance per account | ◐ stocks as at | MetricFlow, LookML |
| Comparison inside a rolling window | ◐ | Rill, MetricFlow |

### 19.2 Modelling

| Capability | Us | Where it exists |
|---|---|---|
| Entities and joins by key; join paths found by the engine | ✗ | Cube, MetricFlow, LookML |
| Fan-out protection — a join that repeats rows cannot inflate a sum | ✗ and the parts-sum check cannot see it | Looker, Cube, MetricFlow |
| Declared grain and primary key | ✗ | Cube, dbt, MetricFlow |
| Dimension attributes — an employee's manager, without splitting by it | ✗ | Cube, LookML, Kimball |
| Hierarchies and drill paths — department tree, country to city | ✗ | Cube, Looker, Rill |
| Values as they were at the time — slowly changing dimensions | ✗ declared, not honoured | dbt snapshots, Kimball |
| The same dimension meaning the same key everywhere | ✗ | MetricFlow, Kimball |
| Display formats | ◐ units only | all |
| Currencies — amounts in their currency, converted at a declared rate and date | ✗ | Looker, Snowflake, custom everywhere |
| Units — hours to days, FTE to hours, by a declared rule | ✗ | custom everywhere |
| Language and locale of labels and numbers | ✗ | Looker, Metabase |
| Curated views — which measures a person or agent sees | ✗ | Cube, LookML, Snowflake semantic views |
| Synonyms and descriptions per measure and dimension | ◐ per program only | Snowflake, Cube, dbt |
| Certified definitions | ✗ | dbt, Metabase, Looker |

### 19.3 Performance

| Capability | Us | Where it exists |
|---|---|---|
| Pre-aggregations — materialised rollups that answer many questions | ✗ | Cube, Snowflake, Rill |
| Freshness-aware refresh; incremental rebuild | ✗ cache never checks the source | Cube, dbt, Snowflake |
| Cost-based planning from recorded timings | ✗ timings recorded, unused | Snowflake, Cube |
| Queues, cancellation, long-running queries | ✗ | Cube, Snowflake, Metabase |
| Results beyond the row cap — paging, streaming | ✗ refused | all |

### 19.4 Correctness and operations

| Capability | Us | Where it exists |
|---|---|---|
| Data tests — unique, not null, relationships, accepted values | ✗ column existence only | dbt |
| Source freshness | ✗ | dbt, Rill |
| Data contracts on columns and types | ◐ interface check on replacement | dbt |
| Column-level lineage | ✗ program level | dbt, Snowflake, Looker |
| Impact of a change before it is made | ◐ past answers listed | dbt, Looker |
| Environments and branches for definitions | ◐ name history | dbt, Cube, LookML |
| A browsable catalogue | ✗ | dbt, Cube, Metabase |

### 19.5 Governance

| Capability | Us | Where it exists |
|---|---|---|
| Row-level security | ◐ policies from the request, applied in the SQL rewrite | Snowflake, Cube, Metabase |
| Column masking | ✗ whole-table denial only | Snowflake, Metabase |
| Measure and dimension visibility per role | ✗ | Cube |
| Multi-tenancy | ✗ | Cube |
| Access audit — who saw which rows | ◐ memory records who asked | Snowflake, Looker |

### 19.6 Using results

| Capability | Us | Where it exists |
|---|---|---|
| Drill-through to the rows behind a number | ✗ | Metabase, Looker, Rill, Cube |
| Tables, charts, pivots rendered | ✗ in the graph | all |
| Dashboards with shared filters | ✗ | Metabase, Rill, Looker |
| Saved questions and reports | ◐ memory, uncurated | Metabase, MetricFlow |
| Schedules and subscriptions | ✗ | Metabase, Looker, Rill |
| Threshold alerts | ✗ — S7 | Rill, Metabase, Looker |
| Export to CSV and spreadsheets | ✗ | all |
| SQL, JDBC, REST or GraphQL access for other tools | ✗ | Cube, dbt Semantic Layer |
| Embedding | ✗ | Cube, Metabase, Looker |

### 19.7 What their agents rely on

| Capability | Us | Where it exists |
|---|---|---|
| Listing measures and dimensions with descriptions, for the agent | ✗ | dbt Semantic Layer MCP, Cube, Snowflake Cortex Analyst |
| Searching any dimension's values — "Acme" to customer 123 | ◐ one hand-written resolver | Cortex Analyst, Metabot, Cube |
| A verified-query library, reused and used as examples | ◐ memory, uncurated | Cortex Analyst |
| Synonyms matched to the question | ✗ | Snowflake, Cube |
| Clarifying an ambiguous question | ◐ the resolver refuses ambiguity | Cortex Analyst, Metabot |
| A plain-language account of how the answer was reached | ◐ trace, no narrative | Cortex Analyst, Looker |
| Feedback turning an answer into a verified example | ✗ | Cortex Analyst, Metabot |
| Evaluation — questions with known answers, re-run on every change | ✗ | agent platforms generally |

### 19.8 Candidates for the foundation

Judged by the rule in section 17 — needed by every analysis, and wrong the same way whenever it is hand-written:
subtotals per measure kind; percent of total and top N per group; rolling windows and relative dates; time zones;
currencies and units; entities with joins by key and fan-out protection; declared grain and dimension attributes;
drill-through to detail rows; searching any dimension's values; listing the graph for agents and a verified-query
library; column masking. *Each to be decided.*

---

## 20. Beyond analysis

The decision layer is a further layer on top of everything above, not yet built. What it and the rest of R8
need, for the same one-by-one treatment:

- **Mechanism programs** — how the organisation responds: hours booked as headcount rises, pipeline to revenue.
  Without them a counterfactual holds everything else fixed.
- **Expectations and anomaly detection** — S7.
- **Causal analysis** — why a number moved, as a branching program with memory — S7.
- **Forecasting and projection** — a stock after today, from plans and trends — S8.
- **Decisions** — options, the criteria between them, a recorded boundary, reopening when data crosses it — S8.
- **Optimisation** — the best allocation under constraints: who staffs which project.
- **Simulation** — many counterfactuals over uncertain inputs, with a distribution, not a point.
- **Strategies** — sequences of actions, remembered with their outcomes, learned from.
- **Outcomes** — what happened after a decision, recorded against it.
- **Notification and workflow** — telling the right person, and acting.

## 21. Open questions

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
11. **The agent builds the graph, so how is a build verified?** Programs and concepts are not handed to the
    system; the authoring agent writes them. Something must establish that what it built is right — not only
    that it runs — before others build on it. *Remembered for later; not being designed now.*
12. **How is the right program found, and how is it known that none exists and one must be written?** Finding
    an existing program and recognising a genuine gap are the same decision seen from two sides.
13. **Sources that are not SQL.** A relation is SQL wrapped by the engine. An API returns rows, not a query to
    wrap. The likely form: the concept fetches rows bounded by `when`, the engine loads them into a local SQL
    engine, and the same wrapping runs there — same shape, same checks, no pushdown to the source. Composition
    with a SQL source then happens after aggregation, as across any two sources. *Not built.*
14. **Measures computed from other measures.** The builder let a measure be any aggregate expression, so
    `SUM(a) / SUM(b)` could be written; it had no ratio kind, so a split would have failed the parts-sum check
    and an average rollup would have averaged ratios. Moving to plain SQL dropped the expression without this
    being noticed — `fte` survived only because dividing by 40 is linear and moved into the row. A shape needs
    derived measures, computed from aggregated measures, of kind ratio, checked through their numerator and
    denominator.

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
