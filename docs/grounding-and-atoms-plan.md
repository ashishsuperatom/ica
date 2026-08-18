# Grounding + Semantic Atoms — build plan

Status: **plan + in-progress build** (branch `feat/grounding`). Generic: nothing here assumes a specific
dataset. Every project has different data; the agents/indexes are built per-project *from* that project's
data, never hard-coded to one schema.

## The two systems (distinct, chained)

**System B — Grounding (isolated module).** value → structured ids. Turns a fuzzy human reference into
concrete entity ids, using indexes over the project's actual data. Three resolvers, one interface:
- `resolveEntity(text, ctx?)` → **per-entity-type** ranked candidates (never one; a name may match several
  types — return top-N *within each* type, weighted by a soft context prior, all types surfaced).
- `resolveHierarchy(node)` → descendants/ancestors. A hierarchy is `{entityType, node→(type,id), resolver}`
  where resolver ∈ **column/FK · derived-query · cross-source · materialized** (branch→service-network is
  derived-query, ~37 SNs/branch — not geography, not 1:1). Not always geo; not always a clean FK.
- `resolveValueByPattern(value)` → candidate `{type, location}` for identifiers (invoice/PAN/GST) via a
  **learned** format→column map.
Search mode here is **fuzzy/lexical-primary** (matching a specific value); semantic is a complement.
Built by the **grounding agent** (cold, admin-triggered). Its own **isolated store** (not `project.sqlite`).

**System A — Knowledge / semantic atoms (stays with the semantic model).** concept → where it lives + how to
work with it. A small typed atom: `{ kind, subject, location, method, coverage, confidence, evidence,
provenance, valid_from/valid_to }`. Atom kinds include **where-to-find · how-to-compute · how-to-join ·
resolution-method · data-quality/reliability**. The data-quality atom is the highest-value one (the broker
case: *"`vehicleplacement.VehicleBrokerId` is 69%-covered; prefer the `operation` path"*). Concepts stay as
**compositions** over atoms; the broad model = fast-path + navigation. Search mode here is **semantic-primary**
(concept/synonym match), lexical complement — `sqlite-vec` over a few thousand atoms is plenty; no Postgres.
Curated by the **modeler** from the analyst's real traces (usage-learned, never invented cold). A new
node-store `kind`.

## Who does what (agent roles — to be mirrored into each prompt)

- **Analyst** — answers the user's question. Consults atoms (what/where/how) + calls grounding (value→id) +
  computes + explores when knowledge is missing. Owns nothing durable; leaves clean traces.
- **Reflex** — fast front door: reuse an existing program or build. No modify (explicit `edit:`/`modify:` only).
- **Modeler** — offline System-4: crystallizes the analyst's traces into the semantic model **+ atoms**.
- **Connector** — admin-facing, per-project: connect/test/register a data source. Not warmed.
- **Grounding agent** (NEW) — admin-facing, per-project, **cold** (not in `warmEssentialAgents`): on trigger,
  introspects the source(s) and BUILDS the grounding module's indexes/hierarchies/patterns, then goes away.
  Reports to its xterm on the admin side. Its output is the grounding store; the analyst reads it at query
  time via the module's functions (the agent is not invoked per query).

## Placement in the codebase

- `vm/packages/grounding/` — the isolated grounding module (contract + resolvers + its own SQLite store).
  Imported by the analyst (query-time) and the grounding agent (build-time). Store on the volume.
- `vm/apps/engine/agents/grounding/` — the grounding agent (mirrors `connector`: claude-code, admin-triggered
  `grounding:run`/`grounding:ask` + `term:attach which:'grounding'`; a `groundingSlot` NOT added to
  `warmEssentialAgents`).
- Semantic atoms — a new `kind` in `@superatom/node-store` (lives in `project.sqlite` with the model);
  modeler writes, analyst reads.

## Build order (grounding first, one piece at a time)

1. **Grounding module skeleton** — contract types + service interface + store schema. *(this piece)*
2. **Hierarchy resolver** — resolver-spec + `resolveHierarchy` over the store (column/derived/cross-source/
   materialized). We understand this one (branch→SN).
3. **Value index resolver** — `resolveEntity`: per-type fuzzy (SQLite FTS5/trigram/spellfix1) + optional
   `sqlite-vec` semantic; ranked per-type candidates; verify against data.
4. **Pattern resolver** — `resolveValueByPattern`: learned format→column map.
5. **Grounding agent** — introspect a source, build all of the above into the store (generic, per-project).
6. **Wire the analyst** — expose the grounding functions as tools it calls before analysis.
7. **Semantic atoms (System A)** — new node kind incl. data-quality atoms; modeler emits, analyst consults.

## Cross-cutting (bake in from the start)

Verification (every resolution/atom checked against live data), provenance + confidence + temporal validity,
context-aware disambiguation, an alias layer, a human-in-the-loop correction path (admin xterm), and the
feedback loop (analyst discovery → data-quality atom → better future grounding). Prior art to borrow from:
Master Data Management, entity resolution / record linkage, schema matching, the semantic layer.
