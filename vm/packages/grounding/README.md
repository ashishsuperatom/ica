# @superatom/grounding

The **isolated grounding module** — value → structured ids. Turns a fuzzy human reference into concrete entity
ids using indexes built **per-project from that project's own data** (nothing dataset-specific here).

```
resolveEntity(text)         value      → ranked candidates PER entity type   (fuzzy/semantic, never one answer)
resolveHierarchy(node)      entity     → descendants / ancestors             (column | derived-query | cross-source | materialized)
resolveValueByPattern(v)    identifier → { type, where it lives }            (learned format → column)
```

- **Isolated store** — its own SQLite (not the semantic model's `project.sqlite`).
- **Built by the grounding agent** (admin-triggered, cold) at setup + on data change; **read by the analyst**
  at query time. The agent is never invoked per query.
- **Distinct from semantic atoms** — atoms are *knowledge* (where/how, with the model); grounding is *value
  resolution* (indexes, here). A semantic unit may say "resolve places via this hierarchy"; grounding executes it.

Status: **skeleton** — contract (`types.ts`) + store schema + builder/reader shells. Real resolvers land next:
hierarchy execution (piece 2), per-type fuzzy+semantic entity search (piece 3), learned pattern matching
(piece 4), then the grounding agent (piece 5). See `docs/grounding-and-atoms-plan.md`.
