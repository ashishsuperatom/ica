# An agent

An agent is what a person opens: its UI, its STATE, the ICA at work in its sessions, and its programs.

- `agent.json` — its title, look and starting points; its programs; where its STATE starts; and its ICA (`ica`: the
  composer answers questions in words) with that ICA's first prompt, its `domain` — the platform's (`composer-domain`),
  carried by the engine release, never written here. The tools are the ICA's, named by its domain.
- `knowledge/index.mts` — the concepts its questions stand on (meaning, rules, joins, traps; never numbers). A question
  reaches them through its intent (the intent graph), never through a domain; nothing routes a question by them.
- `programs/<name>/` — each program, the agent's own: `manifest.json` (the STATE slice it owns: inputs a person sets,
  fields it derives, its filters), `doc.md` (that STATE in words, for the ICA), `server/` (its functions) and `web/`
  (its own block, from @superatom/ui). docs/program-contract.md says what a program must do.

Every step a program answers follows the step standard (DESIGN-SYSTEM.md "A step — the standard"), drawn by the
framework from the answer — the program writes markdown in that order and the blocks it names:

- the **filter row**: filters declared in the manifest (`package.filters`), each a pill spanning 1, 2 or 4 units of the
  row's grid (`size`: small, medium, large), each choice computed from the data in scope by a function of the program,
  with its count and amount — the build refuses one without that function;
- **KPI cards** (the only cards), then **words**: a heading and two or three plain sentences said from the data;
- **sections**, each a plain heading, one line and its content, as an Ask answer reads: a chart drawn plainly (its table
  behind a quiet button), a table shown open (its first 10 rows, "Show more"; its expand button opens it full screen
  for analysis: search, a filter per column, group-by, sort, columns shown or hidden, every row);
- everything on the page at once, nothing folded; the block frame's title is the one heading.

The program here shows each piece: `group` is its filter (`groupOptions` computes the choices), `key` its drill (a bar
or a row opened, answered by `row()` in a new block), `everyKey` and `largestKey` its next moves — **option functions**
(`package.options`), each offering one move computed from the data, or none (docs/program-contract.md "Options").
A program's views are cards in a block by default; `"ui": { "as": "ui" }` in its manifest draws them as an interface of
their own — the whole width, laid out by the program (a dashboard). Charts: `EChart` with any ECharts option.

Two doors, one STATE: a click is an `<Intent>` op; a question in words is answered by the ICA from its intent and the
programs' docs — markdown with marker lines (the answer, kept as the session's answer.md, its attachments beside it) —
and may change STATE with the same ops.

`sacli agent init <name>` makes this folder; `sacli agent push <folder>` is the one step that builds it, writes it and
publishes it — people use it at once (`--draft` to keep it unpublished).
