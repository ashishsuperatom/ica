# Grounding

Generic: nothing here assumes a specific dataset. Every project has different data; the indexes are built per project
*from* that project's data, never hard-coded to one schema.

## What it is

**Grounding (`vm/packages/grounding`) — value → structured ids.** Turns a fuzzy human reference into concrete entity ids,
using indexes over the project's actual data. Three resolvers, one interface:
- `resolveEntity(text, ctx?)` → **per-entity-type** ranked candidates (never one; a name may match several
  types — return top-N *within each* type, weighted by a soft context prior, all types surfaced).
- `resolveHierarchy(node)` → descendants/ancestors. A hierarchy is `{entityType, node→(type,id), resolver}`
  where resolver ∈ **column/FK · derived-query · cross-source · materialized** (branch→service-network is
  derived-query, ~37 SNs/branch — not geography, not 1:1). Not always geo; not always a clean FK. Live kinds are
  resolved against the source, so nothing is copied.
- `resolveValueByPattern(value)` → candidate `{type, location}` for identifiers (invoice/PAN/GST) via a
  **learned** format→column map.

Search mode is **fuzzy/lexical-primary** (matching a specific value). Its store is its own: `db/grounding.sqlite`.

What a concept means, where it lives and how it combines is not grounding's: that is the **semantic graph**
(`docs/semantic-graph.md`) — its objects, arrows, measures, descriptions, synonyms, listed members and the names people
use, read by `./resolve-terms` and `./find-record`.

## Who uses it

- **Grounding agent** (`vm/apps/engine/agents/grounding/`) — admin-facing, per project, **cold** (not warmed): on
  trigger it introspects the source(s) and builds the indexes, hierarchies and patterns, then goes away. It reports to
  its xterm on the admin side.
- **Analyst** — resolves values with `./resolve` (or `grounding/grounding.mjs`) while it explores the data behind an
  escalated question. The agent that built the index is not invoked per query.
- **Connector** — connects, tests and registers the data sources grounding reads.

## Open

- `build()` upserts on top: values gone from the source linger, and a differently-shaped re-run leaves both shapes.
- Every resolution checked against live data, with provenance, confidence and temporal validity; an alias layer and a
  human correction path (admin xterm). Prior art: Master Data Management, entity resolution / record linkage, schema
  matching.
- What the analyst learns about data quality ("this column is 69% covered; prefer the other path") belongs in the
  semantic graph, recorded by the agent that extends it.
