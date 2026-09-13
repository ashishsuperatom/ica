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
from sqlglot.optimizer.normalize_identifiers import normalize_identifiers  # noqa: E402
from sqlglot.errors import ParseError  # noqa: E402
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

# READ-ONLY GATE (default access control): a query is rejected unless it is a pure read. Any of these anywhere in
# the tree fails it — the mutating statements, plus `Into` (T-SQL `SELECT … INTO t` creates a table while looking
# like a Select), plus a raw unparsed `Command` (EXEC/etc. — if SQLGlot can't model it, we can't secure it).
# NOTE: stacked injection (`SELECT 1; DROP …`) is also neutralised structurally — we parse+re-render only the
# FIRST statement, so a trailing statement never reaches the bridge. This is the blunt default; finer per-source
# authorization comes later and plugs in at inject_policies().
FORBIDDEN = (
    exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop,
    exp.Alter, exp.TruncateTable, exp.Command, exp.Grant, exp.Into,
)


def _dialect(name):
    return DIALECTS.get((name or "").lower().strip(), None)


def _limit_value(node):
    """The integer row count from a limit clause — whether it's a LIMIT (exp.Limit) or an Oracle/SuiteQL
    FETCH FIRST n ROWS (exp.Fetch). Both live under the select's `limit` arg. None if not a plain integer."""
    if node is None:
        return None
    lit = node.args.get("count") if isinstance(node, exp.Fetch) else node.expression
    try:
        return int(lit.this) if lit is not None else None
    except (AttributeError, ValueError, TypeError):
        return None


def enforce_cap(root, max_rows):
    """Ensure the outermost SELECT returns at most max_rows (the smaller of any existing limit and max_rows).
    A safety cap so a runaway query can't dump a whole table; a no-op semantics-wise for aggregations.
    Returns (root, capped_to) — capped_to is the injected limit when WE added/tightened one, else None. The
    caller REPORTS that: a cap the caller can't see is indistinguishable from "that's all the data", which is
    how a truncated read becomes a confidently wrong total."""
    if not max_rows or max_rows <= 0:
        return root, None
    select = root if isinstance(root, exp.Select) else root.find(exp.Select)
    if select is None:
        return root, None
    n = _limit_value(select.args.get("limit"))   # holds exp.Limit OR exp.Fetch
    if n is not None and n <= max_rows:
        return root, None                         # agent asked for fewer — keep it
    select.limit(max_rows, copy=False)            # no limit, or one bigger than the cap → clamp to the cap
    return root, max_rows


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


# ── A QUERY THAT READS THE CLOCK ─────────────────────────────────────────────────────────────────────────────
# SYSDATE, GETDATE(), CURRENT_DATE: the text is the same every day and the answer is not, so the manager does
# not cache it.
_CLOCK_NODES = tuple(c for c in (getattr(exp, n, None) for n in (
    "CurrentDate", "CurrentTime", "CurrentTimestamp", "CurrentDatetime",
    "Systimestamp", "Localtimestamp", "Localtime", "UnixTimestamp")) if c)
_CLOCK_NAMES = {"SYSDATE", "SYSTIMESTAMP", "GETDATE", "GETUTCDATE", "SYSDATETIME", "SYSUTCDATETIME",
                "NOW", "CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "TODAY"}


def _reads_clock(root):
    for node in root.walk():
        if _CLOCK_NODES and isinstance(node, _CLOCK_NODES):
            return True
        if isinstance(node, (exp.Anonymous, exp.Column)) and (node.name or "").upper() in _CLOCK_NAMES:
            return True
    return False


def rewrite(req):
    sql = req.get("sql")
    if not sql or not str(sql).strip():
        raise ValueError("empty sql")
    read = _dialect(req.get("read") or req.get("source_dialect"))
    write = _dialect(req.get("write") or req.get("source_dialect") or req.get("read"))
    ctx = {"read": read, "write": write, "source_dialect": req.get("source_dialect")}

    root = sqlglot.parse_one(sql, read=read)  # raises ParseError (with position) on bad SQL

    # READ-ONLY BY DEFAULT — but a switch, not a wall. A source/request that is allowed to take ACTION passes
    # allowWrites:true (finer per-source authorization plugs in at inject_policies() later). Analytics/BI stays
    # locked to reads. When rejecting, say WHY and WHAT to do — a bare rejection makes the agent go blind.
    if not req.get("allowWrites"):
        forbidden = root.find(*FORBIDDEN)
        if forbidden is not None or not root.find(exp.Select):
            verb = (type(forbidden).__name__ if forbidden is not None else type(root).__name__).upper()
            raise ValueError(
                f"query rejected — this source is READ-ONLY, so only SELECT (read) queries run here, but this is "
                f"a {verb} statement. Rewrite it to READ the data with SELECT; writes are not permitted on this source."
            )

    root = hooks.apply_pre_ast(root, ctx)
    root = inject_policies(root, req.get("policies"))
    root, cappedTo = enforce_cap(root, int(req.get("maxRows") or 0))
    out = root.sql(dialect=write)
    out = hooks.apply_post_text(out, ctx)
    # cappedTo travels back so the CALLER can tell the agent a limit was applied — an invisible cap
    # reads as "that is all the data".
    return {"sql": out, "lineage": None, "cappedTo": cappedTo, "readsClock": _reads_clock(root)}


# ── STRUCTURAL SIGNATURE ──────────────────────────────────────────────────────────────────────────────────
# What a query MEASURES, from WHERE, under WHICH conditions — and, separately, the axis it groups by.
#
# The split is the whole point. Grouping one measure a different way is not a different measure, so the
# dimension is kept OUT of the core: three concepts that differ only in GROUP BY share a core and are one
# measure with three axes. A dimension also drags in its own JOIN and its own label column, and those are
# excluded for the same reason — they belong to the axis, not to what is being counted.
#
# NORMALISED, never SIMPLIFIED. Identifiers are case-folded and literals are holed out (a literal that varies
# between runs is a parameter, not a different program). Nothing that changes the ANSWER is touched: join
# type, operators and predicates survive exactly, because LEFT and INNER decide whether unmatched rows exist
# and folding them together would merge concepts that genuinely disagree.
#
# Comments are stripped: they are for whoever reads the code and take no part in what it computes.
#
# This is a SIMILARITY key, not an identity. Two queries can compute the same thing with different shapes —
# a join versus a subquery — and no structural hash will catch that. High precision, low recall: what it
# matches is genuinely related, what it misses is simply left alone.
def signature(req):
    import hashlib, json as _json, re as _re
    sql = req.get("sql") or ""
    # THROUGH THE SAME MAP THE REWRITE USES. Our dialect labels are ours, not SQLGlot's — 'suiteql' is Oracle
    # grammar, 'mssql' is tsql — and passing a label straight to the parser makes every query fail to parse,
    # which reads as "this concept is not a computation". A signature computed with a different dialect than
    # the query runs under could disagree with reality, so there is exactly one mapping and this is it.
    dialect = _dialect(req.get("dialect") or req.get("source_dialect"))
    # A HOLE IS A HOLE, and some holes cannot be bind parameters. `SELECT TOP <n>` takes a number, not a
    # placeholder, so a query perfectly valid in its own convention fails to parse once substituted — and the
    # caller reads that as "this is not a computation" and files a measure as a note.
    #
    # Since the signature replaces every literal with a placeholder anyway, a literal stand-in is not a
    # compromise: it produces exactly the same signature and parses in positions a parameter cannot. So try
    # the parameter form, then a number, then a string, and take the first that parses.
    holes = _re.compile(r"<[^<>]+>|:\w+")
    attempts = [
        _re.sub(r"<([^<>]+)>", lambda m: ":" + _re.sub(r"[^A-Za-z0-9_]", "_", m.group(1)), sql),
        holes.sub("1", sql),
        holes.sub("'x'", sql),
    ]
    tree = None
    last = None
    for candidate in attempts:
        try:
            tree = sqlglot.parse_one(candidate, read=dialect)
            break
        except Exception as e:  # noqa: BLE001 — any parse failure moves to the next stand-in
            last = e
    if tree is None:
        raise last if last else ValueError("could not parse")

    for node in tree.walk():
        node.comments = None
    tree = normalize_identifiers(tree)
    for lit in list(tree.find_all(exp.Literal)):
        lit.replace(exp.Placeholder())

    where = tree.find(exp.Where)
    frm = tree.find(exp.From)
    group = tree.find(exp.Group)
    preds = sorted({c.sql() for c in (where.find_all(
        exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.In, exp.Is, exp.Like) if where else [])})
    # A time restriction is a PARAMETER of a measure, not part of what it measures — one concept written with
    # a year equality and another with a date range are the same measure asked over different windows.
    time_like = _re.compile(r":|date|time|year|month|day|period|trandate", _re.I)
    core = {
        "measures": sorted({f.sql() for f in tree.find_all(exp.AggFunc)}),
        "base": frm.this.name if frm and hasattr(frm.this, "name") else None,
        "filters": [p for p in preds if not time_like.search(p)],
    }
    return {
        "core": core,
        "coreHash": hashlib.sha256(_json.dumps(core, sort_keys=True).encode()).hexdigest()[:12],
        "dimension": sorted({g.sql() for g in group.expressions}) if group else [],
        "timeFilters": [p for p in preds if time_like.search(p)],
        "joins": sorted({(j.side or "INNER") for j in tree.find_all(exp.Join)}),
    }


def handle(req):
    op = req.get("op", "rewrite")
    if op == "ping":
        return {"ok": True, "pong": True}
    if op == "signature":
        return {"ok": True, **signature(req)}
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
        except ParseError as e:  # bad SQL — the message carries the line/col so the agent can fix it
            resp = {"id": rid, "ok": False, "error": "SQL error — " + _ANSI.sub("", str(e))}
        except Exception as e:  # our rejections already carry a clean, actionable message; never let one kill the worker
            resp = {"id": rid, "ok": False, "error": _ANSI.sub("", str(e))}
        sys.stdout.write(json.dumps(resp, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
