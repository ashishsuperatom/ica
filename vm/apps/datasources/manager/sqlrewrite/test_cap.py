# The row cap limits what the query returns as a whole — a UNION at the top is capped around it, not in its first branch.
#   python3 sqlrewrite/test_cap.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'vendor'))
import worker

def rw(sql, source, cap=5000):
    return worker.rewrite({"sql": sql, "source_dialect": source, "maxRows": cap})["sql"]

CASES = [
    ("a union is capped as a whole (Oracle-flavoured)", "SELECT a FROM t UNION ALL SELECT b FROM u", "suiteql",
     "SELECT * FROM (SELECT a FROM t UNION ALL SELECT b FROM u) capped FETCH FIRST 5000 ROWS ONLY"),
    ("a union is capped as a whole (T-SQL)", "SELECT a FROM t UNION ALL SELECT b FROM u", "tsql",
     "SELECT TOP 5000 * FROM (SELECT a FROM t UNION ALL SELECT b FROM u) AS capped"),
    ("a union asking for fewer keeps its own limit", "SELECT a FROM t UNION ALL SELECT b FROM u LIMIT 10", "postgres",
     "SELECT a FROM t UNION ALL SELECT b FROM u LIMIT 10"),
    ("a plain select is capped where it was", "SELECT a FROM t", "postgres", "SELECT a FROM t LIMIT 5000"),
    ("a union inside a subquery leaves the cap outside", "SELECT x.m FROM (SELECT 1 AS m FROM DUAL UNION ALL SELECT 2 AS m FROM DUAL) x", "suiteql",
     "SELECT x.m FROM (SELECT 1 AS m FROM DUAL UNION ALL SELECT 2 AS m FROM DUAL) x FETCH FIRST 5000 ROWS ONLY"),
]
failed = 0
for name, sql, source, want in CASES:
    got = rw(sql, source)
    ok = got == want
    failed += not ok
    print(("ok    " if ok else "FAIL  ") + name + ("" if ok else f"\n      got  {got}\n      want {want}"))
sys.exit(1 if failed else 0)
