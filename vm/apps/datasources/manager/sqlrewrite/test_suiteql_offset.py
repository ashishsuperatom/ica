# NetSuite ignores OFFSET: a SuiteQL query with one is numbered with ROWNUM instead. Oracle proper is left as written.
#   python3 sqlrewrite/test_suiteql_offset.py
import worker

def rw(sql, source="suiteql", cap=0):
    return worker.rewrite({"sql": sql, "source_dialect": source, "maxRows": cap})["sql"]

CASES = [
    ("offset and fetch become a numbered window, in order",
     "SELECT j.id AS id, j.companyname AS name FROM job j ORDER BY j.id OFFSET 100 ROWS FETCH NEXT 3 ROWS ONLY", "suiteql",
     "SELECT id, name FROM (SELECT x.id, x.name, ROWNUM AS rn__ FROM (SELECT j.id AS id, j.companyname AS name FROM job j ORDER BY j.id) x) WHERE rn__ > 100 AND rn__ <= 103 ORDER BY rn__"),
    ("offset alone keeps every row after it",
     "SELECT j.id AS id FROM job j ORDER BY j.id OFFSET 5 ROWS", "suiteql",
     "SELECT id FROM (SELECT x.id, ROWNUM AS rn__ FROM (SELECT j.id AS id FROM job j ORDER BY j.id) x) WHERE rn__ > 5 ORDER BY rn__"),
    ("no offset: untouched", "SELECT j.id AS id FROM job j ORDER BY j.id FETCH FIRST 3 ROWS ONLY", "suiteql",
     "SELECT j.id AS id FROM job j ORDER BY j.id FETCH FIRST 3 ROWS ONLY"),
    ("Oracle proper keeps its OFFSET", "SELECT j.id AS id FROM job j ORDER BY j.id OFFSET 100 ROWS FETCH NEXT 3 ROWS ONLY", "oracle",
     "SELECT j.id AS id FROM job j ORDER BY j.id OFFSET 100 ROWS FETCH NEXT 3 ROWS ONLY"),
]
failed = 0
for label, sql, source, want in CASES:
    got = rw(sql, source)
    ok = got == want
    failed += not ok
    print(("ok    " if ok else "FAIL  ") + label + ("" if ok else f"\n      got:  {got}\n      want: {want}"))
print(f"{len(CASES) - failed}/{len(CASES)} passed")
raise SystemExit(1 if failed else 0)
