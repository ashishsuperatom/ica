# An agent

An agent is a domain of the composition graph, the programs it may run, where its STATE starts, and how it is shown:

- `agent.json` — its title, domain, programs, the agent that answers in words (`ica`), its tools, look and starting points.
- `knowledge/index.mts` — its domain: the concepts it answers from (meaning, rules, traps; never numbers).
- `programs/<name>/` — each program: `manifest.json` (the STATE slice it owns: inputs a person sets, fields it derives),
  `doc.md` (that STATE in words, for the agent), `server/` (its functions) and `web/` (its view, from @superatom/ui).

Two doors, one STATE: a click is an `<Intent>` op; a question in words is answered by the composer from the domain and
the programs' docs — markdown with marker lines (the answer, kept as the session's answer.md, its attachments beside
it) — and may change STATE with the same ops.

`sacli agent init <name>` makes this folder; `sacli agent push <folder>` imports the domain, builds each program and
writes the agent, on the platform (docs/program-contract.md for what a program must do).
