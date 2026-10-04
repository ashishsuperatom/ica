# @superatom/grounding

The **isolated grounding module** — value → structured ids. Turns a fuzzy human reference into concrete entity
ids using indexes built **per-project from that project's own data** (nothing dataset-specific here).

```
resolveEntity(text)         value      → ranked candidates PER entity type   (fuzzy/semantic, never one answer)
resolveHierarchy(node)      entity     → descendants / ancestors             (column | derived-query | cross-source | materialized)
resolveValueByPattern(v)    identifier → { type, where it lives }            (learned format → column)
```

- **Isolated store** — its own SQLite, `db/grounding.sqlite`.
- **Built by the grounding agent** (admin-triggered, cold) at setup + on data change; **read by the analyst**
  at query time. The agent is never invoked per query.
- **Distinct from the composition graph** — what a concept means is an agent's knowledge (`docs/composition-graph.md`);
  grounding is *value resolution* (indexes, here).

Built: the store, the hierarchy, entity and pattern resolvers, and the grounding agent. See `docs/grounding.md`.
