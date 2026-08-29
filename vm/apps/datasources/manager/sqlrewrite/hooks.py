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

# ── POST_TEXT: rendered-SQL fix-ups, keyed by SQLGlot dialect ─────────────────
# Each entry: dialect -> list of (sql, ctx) -> sql. Example seed left empty; add as we learn.
POST_TEXT = {
    # 'oracle': [ _some_text_fixup ],    # e.g. a NetSuite BUILTIN.* spelling SQLGlot renders differently
}


def apply_pre_ast(ast, ctx):
    for fn in PRE_AST.get(ctx.get("write") or "", []):
        ast = fn(ast, ctx)
    return ast


def apply_post_text(sql, ctx):
    for fn in POST_TEXT.get(ctx.get("write") or "", []):
        sql = fn(sql, ctx)
    return sql
