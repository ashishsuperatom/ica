# Runnable concepts — what we are building, and why

Status: steps 1–5 built and verified on branch `concepts/runnable`; one project fully migrated — 33 runnable
concepts, nothing left convertible, 11 kept as notes. Step 6 (acting on clusters) deliberately not started:
the report exists and has found a real duplicate, and what to do about it is still a person's call.

## The problem

A concept today is prose with some code-shaped fields:

```ts
compute?: string      // "how to compute it (a recipe)"  — the seam's own doc calls it "a runnable query"
evidence?: string     // "how it was verified (the query that proved it)"
rules?: string[]      // corrections / constraints
```

Nothing runs any of it. The modeller works out real logic, confirms a real number, and then stores a
*paraphrase* of what it confirmed. The verified artifact is discarded and its description is kept.

Three consequences, all of them observed rather than predicted:

**Rules restate the query, and then drift from it.** In one measure, four of five `rules` were prose
restatements of filters already present in `compute`. Nothing keeps the two honest, so a change to one
leaves the other asserting the old behaviour.

**"Verified" means "someone ran a check once".** A rule reading *"Verified: for a sample invoice,
-SUM(body netamount) == invoice.total exactly"* is a test, recorded as a memory of having run one. It says
nothing about today.

**Computed numbers are frozen into prose.** A caveat carrying *"~10% in 2026: 40.13M vs 44.6M"* is a figure
someone must remember to update, and nobody will.

## What we are changing

A concept becomes **one runnable function**: parameters in, an atomic value (or a distribution) out, with
caveats and assertions produced as it runs. Comments carry the *why*; code carries the *what*.

It stays **atomic and flat** — no composition between concepts. Composition belongs to the agent's program,
where unit reuse already lives. A concept is one idea, one calculation.

It is still **copied, not called**. A real question needs a concept's insides — its filters, its join path,
its sign convention — so the agent takes the body and repurposes it. That is precisely why the code matters:
a prose rule does not survive being copied into a new program, and an assertion does. Adapt the code however
you like; `ctx.verify(...)` still fires on the user's real data if you broke an invariant.

## Why this is worth doing

**Identity becomes computable.** Concept identity is `sha256` over the whole props object, prose included —
so two identical calculations described differently are two concepts. Two measures were found whose SQL is
character-identical apart from a column alias; they are separate concepts *because their prose differs*. With
the body as code, they collide by arithmetic and no judgement is required.

**Duplication becomes visible.** One measure was found written three times, differing only in `GROUP BY` —
and the copies had already diverged: two can express only a calendar year while the third takes a date range,
and one uses `LEFT JOIN` where another uses `INNER`, deciding null handling by accident rather than by
decision. Structural signatures over the AST make that a cluster you can look at.

**Correctness compounds.** Rules that were claims become assertions that run. A concept that stops working is
a concept that fails, not one that quietly returns the wrong number.

**It is the first measurable step toward identity that is discovered rather than assigned.** "Is this the same
idea" has only ever been an opinion, because names are assigned and prose cannot be compared. A structural
signature plus the value a concept last produced gives two independent signals, and the interesting case is
where they disagree: same structure with different values is a parameter map; *different structure with the
same values* is two implementations of one idea, which no amount of naming discipline would surface.

## How a concept gets written

The modeller writes a function — nothing else. It does not write imports, wire `ctx`, choose a file path or
manage a temp directory. A tool does all of that deterministically, because boilerplate is exactly what an
agent gets wrong, and because the wrapper is the same every time.

```
./concept-try   <function source> <params>   → runs it, returns { value | distribution, caveats,
                                                verifications, ms, error }
./concept-save  <runId>                      → persists what that run used
```

Saving takes a **run id, not the source again**: what is stored is exactly what ran, or the verification
proves nothing. The generated file is deleted on success and kept on failure with its path returned, because
a failure the author cannot open is a failure they cannot fix.

**A concept that will not run cannot be saved.** That is the quality gate the whole change buys.

## What stops being a concept

Not everything currently stored is a computation. Alongside measures and lookups there are predicates meant to
be pasted into other queries, strategies describing how to approach a problem, and anti-patterns that carry a
deliberately *broken* query next to the correct one. The last kind can never be a function that returns a
value — half of it must never execute.

These become **notes**: knowledge the agent reads, kept as it is, no longer pretending to be computations.
Forcing them into a function shape would damage them to satisfy a rule they were never part of.

## Nothing here is dataset-specific

The examples above come from one project's store because that is where the evidence was, but nothing in the
design refers to a source, a schema, a dialect or a domain. A concept names its own source and its own
parameters; the tool wraps whatever the modeller wrote; the signature is computed from whatever AST the code
produces. A second project with an entirely different shape of data uses the same contract, the same tool and
the same analysis, and the engine learns nothing about either.

## Order of work

Each step is independently useful — stopping after any of them leaves the system better than before.

1. **The contract** — the `ctx` surface (reusing the scaffold's `read/decide/explain/finish`, adding `verify`
   and `caveat`), the fixed return shape, typed parameters. One concept written by hand against it.
2. **The tool** — `concept-try` / `concept-save`, deterministic wrapper, keep-on-failure, save by run id.
3. **Migrate the store** — classify what exists; convert measures and lookups; move the rest to notes. Convert
   by writing a *new* concept and repointing the index, never in place, so history survives and rollback is a
   repoint.
4. **The modeller authors them** — its instructions become "write a function", `get-concept` serves signature,
   caveats and body, and unrunnable concepts stop being saveable.
5. **Instrumentation** — run on save and store `{value, params, asOf}`; derive a signature over JS *and* SQL
   into a table **outside `ConceptProps`** (putting it inside would rehash and remint every concept); surface
   clusters for review. Observation only; no decisions.
6. **Act** — merges proposed to a person, never automatic. Structural diff plus the `built_from` edges already
   recorded decides what a concept change invalidates downstream. Scheduled re-runs turn "verified once" into
   "verified now".

## What to watch

- Whether concepts written as code are *more* wrong than the prose they replace. An agent writing code can be
  confidently wrong in ways prose is not; step 3 provides the comparison baseline, and it should be used.
- Whether token cost rises once bodies are served instead of paragraphs. The reuse argument depends on it.
- Whether cluster count grows over time. If it does, the modeller is duplicating rather than parameterising,
  and the instrumentation is telling you so.

## What running it taught us

Every one of these was found by building the thing rather than reasoning about it.

**A concept body must be a valid unit body.** `ConceptCtx` is `Omit<UnitCtx, 'use'>` and `UnitCtx` gained
`verify`/`caveat` — not by preference but by force: a concept is COPIED into a unit, so a capability a
concept has and a unit lacks would break the assertions first, which are the whole reason the copy is safe.

**No wrapper file is generated.** The plan was to emit a module with the right imports, run it, delete it.
Unnecessary: `ctx` is an argument, so a concept has nothing to import and the runner just loads it. That also
removed a class of bug this repository has shipped four times — an escape correct in the template and wrong
once written out. (The smoke test's `node --check` guard caught the fourth before it left the machine.)

**Degradation must not look like agreement.** With the SQL half unavailable every concept hashed identically,
so the clustering would have reported that everything duplicates everything. An unsignable statement now
contributes its own normalised text, and `degraded` says the hash rests partly on it.

**A hang must be able to hold the process open.** The timeout was `unref`'d, so a hanging concept exited
before it could fire and reported nothing — worse than failing slowly.

**Stored `source` is prose, not an id**, despite the schema's claim; and our dialect labels are ours, not
SQLGlot's. Both silently misfiled good measures as "not a computation" until the id was recognised against
what the manager actually has and the signature went through the same dialect map the rewrite uses.

**The prose was already stale.** The first migrated concept's description claimed 1,143 active employees; the
data says 1,158. Nothing would ever have noticed, which is the argument for computing rather than quoting,
found inside the store it was written about.

## What the full migration then taught

The watch item was whether concepts written as code come out *more* wrong than the prose they replace. On this
store they did not, and the reason is that the invariants fail loudly where prose simply reads plausibly. Every
item below is a defect the conversion surfaced, and none of them were visible in the description.

**A stated window and the window actually measured were different.** A rule recorded "34 projects going live in
Q3", meaning 34 *remaining between the day it was written and quarter end*. The whole quarter is 132. Both
numbers are right and the sentence joining them is not, and a concept taking an explicit window cannot restate
the ambiguity.

**A filter that looks sufficient is not.** Selecting the Actual charge per time record still left records with
two of them, so a forecast built that way overstated. The invariant caught it on first run; the fix is ranking
to one row, not filtering harder.

**A field was borrowed from the wrong record.** The employee pillar was written as the custom pillar column
that lives on a PROJECT. It does not exist on an employee, so the query failed outright — where prose naming
the same field would have been read straight past.

**A description asserted structure the source does not have.** Utilisation targets were documented as
pillar-specific; the record has no pillar column at all. The concept can only be written against what is there.

**An invariant that cannot fail is not an invariant.** One check counted duplicate rows inside a query that had
already removed them, and answered zero for ever. It read as a passing check for as long as nobody looked.

**A migration must be safe to run twice, and say so honestly the second time.** The classifier handed already
converted JavaScript to a SQL parser, which reported it as prose that still needed migrating.

**A formula parses.** `nativeTotal * rate = audEquivalent` is an explanation written for a person and a valid
expression to a parser, so a note was classified as a query. A runnable statement starts as a read, and never
selects from a placeholder — a hole in table position means a template rather than a computation.

**Retirement is a repoint, not a delete.** A superseded concept still owns every name people search by, so
deleting it takes those names down with it. Moving them to the replacement leaves the old body unnamed and
unreachable, which is what "retired" already means for a superseded version.

**Two independent signals, working as intended.** The cluster report reads three invoice concepts as one
measure along three axes — identical totals, different `GROUP BY` — and two headcount concepts as a genuine
duplicate: same core, same axis, same 1,158. The first needs nothing; the second is a merge, and it is being
proposed rather than performed.
