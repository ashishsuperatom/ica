# How you deliver an answer: BUILD A PROGRAM

Your deliverable is not a hand-written answer — it is a **program** that computes the answer, plus the
answer it produces. A program is the reusable, inspectable artifact; the number a person sees is the
output of *running* it. Do your discovery however you like (probe with `query`, read the model), but once
you know how to answer, crystallize it into a program.

## First: can an existing program answer this?
Look in `./programs/`. If one already fits this question (exactly, or with different parameters like a
different name/date/lane), REUSE it — run it with the right params and use its output. Author a new
program only when none fits. Fewer new programs over time is the goal.

## The shape
Create `./programs/<slug>/` (a short, descriptive slug for the question). Inside:
- `units/*.ts` — one file per unit. Each unit has three exports:
  - `export const meta` — MEANING: `{ name, concept, description, inputs, outputs, logic, dataSources }`.
  - `export default async function (ctx, params)` — COMPUTE: a function of its input. **Parameterise it**
    (bindings like a name/lane; and compute relative time — "this month", "last 90 days" — from an `asOf`
    param that defaults to today, so the same unit answers the same question next month).
  - `export const ui` — `{ category: 'simple' | 'dashboard' }`. `simple` = one result (a number, a table,
    a list). `dashboard` = several components answering a richer question from several angles.
- `program.ts` — the root unit: `meta.concept: 'program'`, an `export const question = '<the question>'`,
  and a `default` that COMPOSES units with `ctx.use` and **ends by returning a final UI unit's output**.

Keep intermediate units' `ui` minimal; the real presentation lives in the final UI unit, whose output is a
view-model the front-end renders — carry the same fields the answer schema asks for (category, a labelled
headline with its unit, a table, a short caveat, periods for comparisons).

## Structured keys vs names — keep them in separate layers
A unit computes over **structured keys** (ids / primary keys / dates / numbers), never over a raw name. A
name is unstructured — it is fuzzy, it changes, and one name can mean several records — so **name→id is its
own resolver unit**, and the program composes it first:
`program({name}) → resolve(name)→id(s) → unit({id(s)})`.
- The question already gives an **id / primary key** → pass it straight to the unit (`resolvedBy:"direct"`, no resolver).
- The question gives a **name** → add/reuse a resolver unit (name→id) and feed its output to the compute unit.
- **Exception** — when a name/pattern IS the logic (a substring/`LIKE` match that can resolve to hundreds or
  thousands of ids), keep the pattern INSIDE the unit's query; do not pre-resolve it to a passed id-list
  (`type:"pattern"`, `resolvedBy:"inline"`).

The point: the **compute unit is identical** whether the caller has a name or an id — the only difference is
whether a resolver runs first. (A later search layer will do name→id globally; the shape is the same, so
author to it now.)

## The four ctx capabilities (nothing else)
- `ctx.query(sourceId, sql, params)` — your own SQL/API to the source. The model tells you WHICH
  tables/joins/measures; you write the query. Bind values with named params.
- `ctx.use(name, params)` — run/compose another unit in this program.
- `ctx.decide(label, condition, reason)` — mark a branch (records which path and why); returns the condition.
- `ctx.log(message)` — an optional human progress line.

## Run it, verify it, then hand it off — you do NOT write the answer
1. Run it: `tsx run.mjs programs/<slug>/program.ts '<jsonParams>'`. Read the output. Fix until it is
   correct and its shape is clean (stable field names, every value carrying its unit).
2. Point at it: write `./out/<qid>/built.json` = `{ "programDir": "programs/<slug>", "params": { …the
   params… }, "terms": [ …see below… ] }`. **Do NOT write answer.json** — the engine RUNS your program and
   writes the answer from its real output. The number the user sees is the program's, never one you typed, so a
   correct program is the whole job. (If you type a figure into an answer file, it is ignored.)
   In `params` put ONLY the IDENTITY bindings (the keys/names/filters the program is about) — NOT today's date
   or `asOf`. When this question is asked again the engine RE-RUNS the program against current data, and the
   program must compute the current date itself each run; a frozen `asOf` in params would make every repeat stale.

   `terms` DECLARES the parameter-bearing spans you pulled from the question — one entry per binding, tagged by
   how it resolved. You already know these (you bound them to write the query); just record them, nothing extra:
   ```json
   { "role":  "<the program input this fills>",
     "text":  "<the exact span from the question>",
     "type":  "id | name | date | window | number | pattern",
     "entity":"<for an id/name: the concept it identifies>",
     "value": "<the STRUCTURED value — the id(s) a name resolved to, or the literal for a date/number>",
     "resolvedBy": "direct (already an id) | resolver-unit (a name→id unit) | inline (pattern stays in the query)" }
   ```
   This is how the same computation is recognised whether it was phrased with a name or with an id — record what
   you actually bound.

Correctness first: only claim a result at the scope you actually computed. "Unmodeled" is never a reason to
bail — explore the data and compute it yourself.

EVERY question becomes a program — including a genuine unknowable. An unknowable program still runs: it
verifies the gap against the data (query the evidence — e.g. the column is 100% null, or the records stop
before the asked scope), then its FINAL output object carries `status: "unknowable"` and a short `missing`
reason (plus whatever evidence it checked). Do not hand-write an unknowable verdict; encode it as a program so
it is deterministic and re-checkable — when the data later fills in (or the model-builder finds the source you
missed), the same program re-runs and can flip to answered. The engine keeps your output's `status` as-is, so
an unknowable program stays unknowable; an answered program's output omits `status` (defaults to answered) or
sets it to `"answered"`.
