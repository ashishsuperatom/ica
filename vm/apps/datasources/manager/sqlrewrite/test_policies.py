# Access policies applied by the rewrite: row filters, denials and column masks.
#   python3 sqlrewrite/test_policies.py
import worker

def rw(sql, policies, read="oracle"):
    try:
        return worker.rewrite({"sql": sql, "read": read, "write": read, "policies": policies, "maxRows": 0})["sql"]
    except worker.Denied as e:
        return f"REFUSED: {e}"

MASK = [{"table": "employee", "column": "salary", "mask": "null"}]
CASES = [
    ("a masked column keeps its name", "SELECT e.id, e.salary FROM employee e", MASK, "SELECT e.id, NULL AS salary FROM employee e"),
    ("inside aggregates and aliases", "SELECT SUM(e.salary) AS total FROM employee e", MASK, "SELECT SUM(NULL) AS total FROM employee e"),
    ("the same name on another table is not touched", "SELECT d.salary FROM employee e JOIN department d ON d.id = e.department", MASK,
     "SELECT d.salary FROM employee e JOIN department d ON d.id = e.department"),
    ("inside a subquery", "SELECT x.salary FROM (SELECT e.salary FROM employee e) x", MASK, "SELECT x.salary FROM (SELECT NULL AS salary FROM employee e) x"),
    ("refused: * over the table", "SELECT * FROM employee", MASK, "REFUSED"),
    ("refused: unqualified among several tables", "SELECT salary FROM employee e JOIN department d ON d.id = e.department", MASK, "REFUSED"),
    ("a row filter on every read, joins included", "SELECT e.id FROM employee e LEFT JOIN employee m ON m.id = e.supervisor",
     [{"table": "employee", "predicate": "{t}.subsidiary = 3"}],
     "SELECT e.id FROM (SELECT * FROM employee WHERE employee.subsidiary = 3) e LEFT JOIN (SELECT * FROM employee WHERE employee.subsidiary = 3) m ON m.id = e.supervisor"),
    ("refused: a denied table", "SELECT COUNT(*) FROM timebill tb", [{"table": "timebill", "deny": True}], "REFUSED"),
]

failed = 0
for label, sql, policies, want in CASES:
    got = rw(sql, policies)
    ok = got.startswith("REFUSED") if want == "REFUSED" else got == want
    failed += not ok
    print(f"{'ok ' if ok else 'FAIL'} {label}" + ("" if ok else f"\n     got:  {got}\n     want: {want}"))
raise SystemExit(1 if failed else 0)
