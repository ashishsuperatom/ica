# A bound value (@name) reaches the source as written, in every dialect — never $name (Postgres) or ABS(name) (DuckDB,
# where @ is the absolute value) — and an @ inside a string is not a value.
#   python3 sqlrewrite/test_params.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'vendor'))
import worker

SQL = "SELECT r.name, '@not_a_value' AS s FROM regions r WHERE r.name = @region AND o.d >= CAST(@from AS date) AND o.n = @region"
bad = []
for d in ['postgres', 'mysql', 'mssql', 'tsql', 'duckdb', 'oracle', 'clickhouse', 'suiteql', 'sa-warehouse']:
    out = worker.rewrite({"sql": SQL, "source_dialect": d, "maxRows": 5000})["sql"]
    if out.count('@region') != 2 or '@from' not in out or "'@not_a_value'" not in out or '$' in out or 'ABS(' in out or 'sa_param__' in out:
        bad.append(f"{d}: {out}")
if bad:
    print("a bound value was changed:\n  " + "\n  ".join(bad)); sys.exit(1)
print("ok — @name passes through every dialect")
