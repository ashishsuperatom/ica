// The node store is a property-graph findability index (NOT an execution engine).
// It records unit-nodes (generic LLM-authored function-nodes) and how they relate,
// so agents can discover and reuse existing computation instead of re-inlining it.
//
// Scale assumption: ~1-2k nodes. SQLite + a few helpers cover every access pattern
// (text search via FTS5, dependency walks via recursive CTEs, tree-vs-DAG via edge
// type) with zero graph-DB dependency. See ARCHITECTURE.md §3c.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,          -- stable id; for units, a content/identity hash
  kind        TEXT NOT NULL,             -- 'unit' | 'program' | 'source' | 'concept' | ...
  label       TEXT NOT NULL,             -- human/agentic name, e.g. 'find_dead_stock'
  summary     TEXT,                      -- one-line description (drives FTS + agent recall)
  props       TEXT NOT NULL DEFAULT '{}',-- JSON: signature, params schema, etc.
  file_path   TEXT,                      -- where the source lives ("everything is a file")
  valid_from  INTEGER NOT NULL,          -- ms epoch; bitemporal lower bound
  valid_to    INTEGER                    -- NULL = currently valid; set on supersede
);

CREATE INDEX IF NOT EXISTS nodes_kind  ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS nodes_live  ON nodes(valid_to) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS edges (
  id      INTEGER PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  type    TEXT NOT NULL,                 -- 'uses' (dependency DAG) | 'belongs_to' (tree) | ...
  props   TEXT NOT NULL DEFAULT '{}',    -- JSON: e.g. the params a caller passed {cutoff:90}
  UNIQUE(from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id, type);
CREATE INDEX IF NOT EXISTS edges_to   ON edges(to_id, type);

-- Agentic text search (broaden/narrow scope, rank) — lexical, not semantic.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  label, summary, props,
  content='nodes', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, label, summary, props)
  VALUES (new.rowid, new.label, new.summary, new.props);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, label, summary, props)
  VALUES ('delete', old.rowid, old.label, old.summary, old.props);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, label, summary, props)
  VALUES ('delete', old.rowid, old.label, old.summary, old.props);
  INSERT INTO nodes_fts(rowid, label, summary, props)
  VALUES (new.rowid, new.label, new.summary, new.props);
END;
`
