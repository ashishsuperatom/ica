# sqlrewrite — the SQL access seam (SQLGlot)

The manager rewrites every agent query for a `kind:'sql'` source here: parse → SELECT-only allow-list →
per-dialect hooks (`hooks.py`) → authorization inject → row cap → render to the source dialect. Node owns the
process pool + lifecycle (`../src/sqlglot-pool.ts`); this dir is the Python side.

- `worker.py` — one long-lived worker (JSON-lines on stdin/stdout). Never holds state between requests.
- `hooks.py` — OUR per-dialect variations/clean-ups, run before + after SQLGlot's transform. Add learnings here.
- `vendor/` — SQLGlot, pip-installed and committed (pure-python, zero deps) so the image needs only a `python3`
  interpreter, no build-time install.

## Refresh the vendored dependency

```sh
rm -rf vendor && python3 -m pip install --target vendor --no-compile -r requirements.txt
```

Bump the pinned version in `requirements.txt` first if upgrading. Commit the resulting `vendor/` tree.
