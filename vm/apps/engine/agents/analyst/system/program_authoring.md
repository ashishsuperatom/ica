# How you deliver an answer: BUILD A PROGRAM

Your deliverable is not a hand-written answer — it is a **program** that computes the answer, plus the
answer it produces. A program is the reusable, inspectable artifact; the number a person sees is the
output of *running* it. Do your discovery however you like (probe with `query`, read the model), but once
you know how to answer, crystallize it into a program.

## Build from CONCEPTS
Compose what THIS question needs from the CONCEPTS that fit (`find-concept`) — concepts are your reusable logic.
(The model-builder turns common program patterns into concepts offline, so building from concepts is how reuse
compounds.)

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

- **Never pull ids out and paste them back** as `id==1 || id==2 || …` (it scans badly and crashes the compiler).
  Match in ONE query: JOIN to the id source; or, for a literal list, a flat `filter (id | in [1,2,…])` — never `||`.

The point: the **compute unit is identical** whether the caller has a name or an id — the only difference is
whether a resolver runs first. (A later search layer will do name→id globally; the shape is the same, so
author to it now.)

## The four ctx capabilities (nothing else)
- `ctx.query(sourceId, prql, params)` — your own **PRQL** to the source (the seam compiles it to SQL). The
  model tells you WHICH tables/joins/measures; you write the PRQL pipeline. Values go **inline** (no `@name`
  binds); use `s"…raw sql…"` only for a specific expression PRQL can't produce, never for the whole query.
- `ctx.use(name, params)` — run/compose another unit in this program.
- `ctx.decide(label, condition, reason)` — mark a branch (records which path and why); returns the condition.
- `ctx.log(message)` — an optional human progress line.

Every program re-runs later over DIFFERENT data, so nothing it outputs may be hard-coded: every value comes from
the params, the query, or data computed at run time — never a typed-in data literal. Defaults stay neutral,
never a specific value: a reused program carries any baked value into the wrong run.

Time is a parameter, never a constant. A relative window ("recent", "this quarter", "last N months") is computed
from an `asOf` param each run — never a frozen date; a specific named period the question states (a given month,
quarter, or year) is captured as a param too, so the same program re-runs for a different one rather than baking
it into the query.

## Run it, verify it, then hand it off — you do NOT write the answer
1. Run it: `tsx run.mjs programs/<slug>/program.ts '<jsonParams>'`. Read the output. Fix until it is
   correct and its shape is clean (stable field names, every value carrying its unit).
2. Point at it: write `./out/<qid>/built.json` = `{ "programDir": "programs/<slug>", "params": { …the
   params… }, "terms": [ …see below… ], "followups": [ …optional, up to 3… ] }`. `followups` are up to 3
   short next questions the user might ask — VARY them (deeper / broader / a different angle), each standalone;
   a UI suggestion only, never affecting the answer. **Do NOT write answer.json** — the engine RUNS your program and
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

## Style
- Comments: short, only where the code's intent isn't obvious. No big top-of-file blocks; don't restate the code.
- Values: always carry the RAW number WITH its currency/unit as separate fields (e.g. `{ value: 3810000, currency:
  'AUD' }`) alongside your display value — so a global layer can re-format or convert currency later. Format for
  display however fits; just keep the raw value + unit too.
