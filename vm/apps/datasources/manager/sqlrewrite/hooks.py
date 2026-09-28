# OUR per-dialect variations & clean-ups — the layer we own ON TOP of SQLGlot's transformation.
#
# SQLGlot parses + transpiles + renders correctly for the dialects it knows. But some sources (notably NetSuite
# SuiteQL, which we parse as `oracle`) have constructs SQLGlot's built-in dialect does NOT natively cover, and we
# also accumulate our own learnings ("for this source, always rewrite X → Y"). Those go HERE, as two ordered
# stages around the render:
#
#   parse(read) → [PRE_AST hooks]  → policy-inject → cap → render(write) → [POST_TEXT hooks] → final SQL
#
# PRE_AST hooks   : (ast, ctx) -> ast   — structural rewrites on the tree (PREFERRED; correct, scope-aware).
# POST_TEXT hooks : (sql, ctx) -> sql   — string fix-ups on the rendered SQL (fallback for things the AST can't
#                                          model, e.g. a source-specific function spelling).
#
# ctx = { 'read': <sqlglot dialect>, 'write': <sqlglot dialect>, 'source_dialect': <our name, e.g. 'suiteql'> }.
#
# RULE (same discipline as the old DIALECT_FIXUP): only add a transform that is DETERMINISTIC and ALWAYS-valid for
# that source — a mechanical rewrite, never a heuristic guess. Keyed by the SQLGlot dialect name (what we render
# as). Add a learning = append one function to the right list. Keep each hook small, pure, and documented.

import sqlglot
from sqlglot import exp

# ── PRE_AST: structural rewrites, keyed by SQLGlot dialect ────────────────────
# Each entry: dialect -> list of (ast, ctx) -> ast. Example seed left empty; add as we learn.
PRE_AST = {
    # 'oracle': [ _some_ast_rewrite ],   # SuiteQL-specific structural fix-ups go here
}

# ── PRE_AST by SOURCE: rewrites that hold for one kind of source, not for every source rendered in its dialect ──
# SuiteQL renders as oracle, but real Oracle is not NetSuite: a NetSuite quirk is keyed by our source dialect name.

def _offset_as_rownum(ast, ctx):
    """NetSuite's SuiteQL endpoint honours FETCH FIRST but ignores OFFSET silently — page two comes back as page one.
    A SELECT with an OFFSET is rewritten to number its rows with ROWNUM over the ordered query and keep the rows after
    the offset (and up to the offset plus the FETCH/LIMIT count, when there is one), in their order. The columns out
    are the query's own; a query selecting * keeps * and also returns the row number."""
    for select in list(ast.find_all(exp.Select)):
        off = select.args.get("offset")
        if off is None:
            continue
        try:
            skip = int(off.expression.this)
        except (AttributeError, ValueError, TypeError):
            continue   # not a plain number: left as written rather than guessed
        lim = select.args.get("limit")
        count = None
        if lim is not None:
            lit = lim.args.get("count") if isinstance(lim, exp.Fetch) else lim.expression
            try:
                count = int(lit.this)
            except (AttributeError, ValueError, TypeError):
                continue
        inner = select.copy()
        inner.set("offset", None)
        inner.set("limit", None)
        names = [e.alias_or_name for e in inner.expressions]
        star = any(isinstance(e, exp.Star) or (isinstance(e, exp.Column) and isinstance(e.this, exp.Star)) for e in inner.expressions) or not all(names)
        cols = ["x.*"] if star else [f"x.{n}" for n in names]
        numbered = sqlglot.select(*cols, "ROWNUM AS rn__", dialect="oracle").from_(inner.subquery("x"))
        where = f"rn__ > {skip}" + (f" AND rn__ <= {skip + count}" if count is not None else "")
        outer = sqlglot.select(*(["*"] if star else names), dialect="oracle").from_(numbered.subquery()).where(where, dialect="oracle").order_by("rn__", dialect="oracle")
        if select is ast:
            ast = outer
        else:
            select.replace(outer)
    return ast


PRE_AST_BY_SOURCE = {
    "suiteql": [_offset_as_rownum],
}

# ── POST_TEXT: rendered-SQL fix-ups, keyed by SQLGlot dialect ─────────────────
# Each entry: dialect -> list of (sql, ctx) -> sql. Example seed left empty; add as we learn.
POST_TEXT = {
    # 'oracle': [ _some_text_fixup ],    # e.g. a NetSuite BUILTIN.* spelling SQLGlot renders differently
}


def apply_pre_ast(ast, ctx):
    for fn in PRE_AST.get(ctx.get("write") or "", []):
        ast = fn(ast, ctx)
    for fn in PRE_AST_BY_SOURCE.get((ctx.get("source_dialect") or "").lower(), []):
        ast = fn(ast, ctx)
    return ast


def apply_post_text(sql, ctx):
    for fn in POST_TEXT.get(ctx.get("write") or "", []):
        sql = fn(sql, ctx)
    return sql
