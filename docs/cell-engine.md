# The cell — a person's own engine (PARKED, 2026-11-10)

**Parked until a serious need** (the user, 2026-11-10): what a cell is for — the connector builder, long-running work,
isolation — is not settled; nothing more is built until it is. What exists is a first, complete path that changes
nothing for anyone without a cell.

## What a cell is

The **same engine**, in **cell mode**, for **one person in one project**: the same composer, analyst and workbench, the
same folder layout, its own datasource manager — running somewhere else, for isolation and for long work that should not
weigh on the project's engine. It links through the person's **UserDO**, never to the ProjectDO directly. Any number of a
person's cells may connect; one is their **primary**, as with engines.

## What is built

- **Mode** (`vm/apps/engine/mode.ts`): `SA_ENGINE_MODE=project|cell` (default `project`), `SA_CELL_PERSON` (email) for a
  cell. What differs (one map in `mode.ts`): the project's reports, pushes (sessions, programs, usage), index building
  and release are the project engine's; a cell keeps the replicas and its person's connections.
- **Link** (`control-plane/superadmin/src/user-cell.ts`, `user-hub.ts`, ProjectDO `personLink` surface `cell`): the cell
  connects as a key's socket (`/_ws/<project>?agent=1&person=<id>`, the person's key in its hello, `role: 'cell'`); the
  UserDO checks the key; the ProjectDO admits it as that person's cell — welcomed as an engine is; the first is primary,
  others standby. A cell's messages pass the door without being remembered as asked.
- **What a cell may ask** (`cell-door.ts`): the graph and index replicas; of what is per person, only its own person's —
  the connections read with each person's own key (never the project's secrets for them) and the person's own, that
  person's key, that person's access. Anything else refused with the reply its asker waits for. The replicas' change
  signals reach cells too. A member (a cell on its person's key) may read a connection's code (bridge).
- **A conversation in a cell, chosen by the person**: the ask bar's **+** offers **In my cell** only while their cell runs
  (welcome `cell`, `cell:status`); a conversation started there is placed in that cell — its messages go to it, its
  answers come back to that person only; a stopped cell is said plainly. Nothing decides on its own.
- Tests: `vm/apps/engine/test/mode.test.mts`; `control-plane/superadmin/src/__tests__/cell-link.test.ts`, `cell-door.test.ts`.

## Open (when it comes back)

- **Attaching a cell** — one key, one command, on any machine, as an engine is installed:
  `curl -fsSL https://get.superatom.site/engine/install.sh | sh -s -- --cell <your key for the project>`. The installer
  asks the person's UserDO for the cell's own credential (issued for that cell, bound to the person and the project,
  revocable on its own — the box never keeps the person's key), writes every setting itself (cell mode, the person, hub,
  project, the manager's secret, ports, home), pulls the project's release and starts it. Not built: today a cell runs on
  the person's own key, its settings written by hand.

- **What a cell is used for**, and who sends work there: the person (built), or the project's composer handing work to it
  (the connector builder, long jobs) — the intended later path.
- The composer and analyst in a cell need, through the door, what an engine asks for its person's work: intents
  (find/get/pass/learn/next), session sync (so its conversations are in the person's list), usage, programs.
- **Model keys and credentials** for a cell: today they come with the project's engine key, which a cell does not hold.
- **Shared data from a cell — federated datasource managers** (designed with the user): one registry of the project's
  sources in the ProjectDO (each with its holder), synced to every engine and cell like the index (push for speed, check
  for correctness); every DSM runs what it holds and forwards the rest ONCE to its holder through its engine's socket;
  the holder applies the person's policies, caches (per person — the key carries the rewritten SQL) and records; not
  there → a code, stop; names keyed by (name, holder) — local wins, else the primary engine, else the latest; a cell's
  sources only its person's (exposing them to another person: a permission, later); schema search replicated (the index,
  per source by hash), never routed; every query recorded with its holder, connector version, person and the registry's
  hash.
- Token refresh for a person's OAuth sign-in belongs in their UserDO (where the tokens are kept) — worth doing on its own.
- TASK mode (one person, one job: does it and is gone) — later.
