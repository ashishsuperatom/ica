#!/usr/bin/env python3
# SQLGlot rewrite worker — one long-lived process in the manager's pool.
#
# PROTOCOL: line-delimited JSON on stdin/stdout. One request per line, one response per line, flushed. The
# manager (Node) owns the pool, checkout, idle-reaping and lifecycle; this process just does CPU work and never
# holds state between requests. It must NEVER die on a bad request — every request is answered (ok:false on error)
# so the manager's checkout slot is always returned.
#
#   request : {"id": <any>, "op": "rewrite"|"ping",
#              "sql": "...", "read": "tsql", "write": "tsql",
#              "source_dialect": "mssql", "policies": [...], "maxRows": 5000}
#   response: {"id": <any>, "ok": true,  "sql": "...", "lineage": null}
#             {"id": <any>, "ok": false, "error": "message"}
#
# Pipeline: parse(read) → SELECT-only allow-list → OUR pre-AST hooks → inject policies → enforce row cap
#           → render(write) → OUR post-text hooks → final SQL.

import json
import os
import re
import sys

_ANSI = re.compile(r"\x1b\[[0-9;]*m")  # SQLGlot highlights the error span with terminal codes — strip for the agent

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import sqlglot  # noqa: E402  (vendor path must be set first)
from sqlglot import exp  # noqa: E402
import hooks  # noqa: E402  (sibling module)

# Our source-dialect name → the SQLGlot dialect we parse/render as. Unknown → None (SQLGlot's permissive default).
DIALECTS = {
    "mssql": "tsql", "tsql": "tsql", "sqlserver": "tsql",
    "suiteql": "oracle", "oracle": "oracle", "netsuite": "oracle",
    "postgres": "postgres", "postgresql": "postgres",
    "sqlite": "sqlite", "duckdb": "duckdb", "mysql": "mysql",
    "snowflake": "snowflake", "bigquery": "bigquery",
    "ansi": None, "": None,
}

# Statements that MUST be rejected — this is the access-control allow-list (only read queries pass). A single
# unparsed `Command` (raw EXEC/etc.) is rejected too: if SQLGlot can't model it, we can't secure it.
FORBIDDEN = (
    exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop,
    exp.Alter, exp.TruncateTable, exp.Command, exp.Grant,
)


def _dialect(name):
    return DIALECTS.get((name or "").lower().strip(), None)


def enforce_cap(root, max_rows):
    """Ensure the outermost SELECT returns at most max_rows (the smaller of any existing limit and max_rows).
    A safety cap so a runaway query can't dump a whole table; a no-op semantics-wise for aggregations."""
    if not max_rows or max_rows <= 0:
        return root
    select = root if isinstance(root, exp.Select) else root.find(exp.Select)
    if select is None:
        return root
    existing = root.args.get("limit") if isinstance(root, exp.Select) else None
    if existing is not None:
        try:
            n = int(existing.expression.this)
            if n <= max_rows:
                return root  # agent asked for fewer — keep it
        except (AttributeError, ValueError, TypeError):
            pass
    return root.limit(max_rows)


def inject_policies(root, policies):
    """Authorization seam. policies is a list; each item is either:
        {"predicate": "<sql bool expr>"}                 → AND-ed into the outermost WHERE, or
        {"table": "<name>", "predicate": "<sql expr>"}   → AND-ed wherever that table is queried.
    Empty/None → no-op. (Row-level security is injected HERE, server-side; the agent never sees it.)"""
    if not policies:
        return root
    for pol in policies:
        pred = pol.get("predicate")
        if not pred:
            continue
        table = pol.get("table")
        if table:
            for tbl in root.find_all(exp.Table):
                if (tbl.name or "").lower() == str(table).lower():
                    sel = tbl.find_ancestor(exp.Select)
                    if sel is not None:
                        sel.where(pred, copy=False)
                    break
        else:
            target = root if isinstance(root, exp.Select) else root.find(exp.Select)
            if target is not None:
                target.where(pred, copy=False)
    return root


def rewrite(req):
    sql = req.get("sql")
    if not sql or not str(sql).strip():
        raise ValueError("empty sql")
    read = _dialect(req.get("read") or req.get("source_dialect"))
    write = _dialect(req.get("write") or req.get("source_dialect") or req.get("read"))
    ctx = {"read": read, "write": write, "source_dialect": req.get("source_dialect")}

    root = sqlglot.parse_one(sql, read=read)  # raises ParseError (with position) on bad SQL

    forbidden = root.find(*FORBIDDEN)
    if forbidden is not None or not root.find(exp.Select):
        kind = type(forbidden).__name__ if forbidden is not None else type(root).__name__
        raise ValueError(f"only read queries (SELECT) are allowed here — got {kind}")

    root = hooks.apply_pre_ast(root, ctx)
    root = inject_policies(root, req.get("policies"))
    root = enforce_cap(root, int(req.get("maxRows") or 0))
    out = root.sql(dialect=write)
    out = hooks.apply_post_text(out, ctx)
    return {"sql": out, "lineage": None}  # lineage: wired later once the schema is fed from the datasource-index


def handle(req):
    op = req.get("op", "rewrite")
    if op == "ping":
        return {"ok": True, "pong": True}
    result = rewrite(req)
    return {"ok": True, **result}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            resp = handle(req)
            resp["id"] = rid
        except Exception as e:  # never let one bad request kill the worker
            resp = {"id": rid, "ok": False, "error": _ANSI.sub("", f"{type(e).__name__}: {e}")}
        sys.stdout.write(json.dumps(resp, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
