# What a person sees, and developing a project (`sacli clone`, `sacli dev`)

**Status (2026-10-13):** the first rule is built and deployed (programs run their published build; the draft by asking).
The rest is the plan, agreed in outline with the user.

## In the user's words

"Only published ones should be shown to the user — for everything, concept, program… — but we can modify that behaviour
for any user, so when we do dev we are just passing a param, like `ask --draft` or `--v2`."

"Whenever someone says I want to do dev, we create a folder called dev-<id>, and whenever any message comes we pick the
program from this folder when possible and fall back to the default published ones when not. Once they are done they
detach, and we clear the dev session. This is different from draft or version, because those can be used any time; dev
is only while we are attached to a dev flow. The id is a development session id, not a chat session: sacli makes it, and
when we stop it sends a message that this development can be cleared. Everything remains in the local folder of the
person developing."

"When a person develops, they have no information — not the CSS of the design, not how to create components; their
coding agent will not know either. And while they develop it also runs in production — the Node.js code would ideally
run on their machine, but data access still happens on the engine. If it runs in the engine we must copy every change
there. And we must be able to run different versions of the same thing in the engine, without the engine's disk
bloating: things not used for a long time slowly removed — always working as if everything is there, without everything
being there."

## The rule: one resolver, three layers

Everything a session reads — a concept, a domain, an agent, the map, a program — is found by **one rule**:

```
dev session (if the person is attached)  →  base: published  |  draft  |  vN  →  not found
```

- **Base, published** — what everyone gets, always, unless they ask otherwise.
- **Base, draft or vN** — asked for by someone who may publish (`sacli ask --graph draft`, `session:open graph`): the
  knowledge at that version; with the draft, programs' newest builds too. Usable any time; kept by the session.
- **Dev session** — an overlay on top of the base, alive only while its owner is attached: "for my dev session, the
  program `today` is this build, the agent `today` is this". Whatever it does not name falls through to the base.

A session records the layers it was opened with, so it keeps meaning the same thing (as it keeps its program hashes).

## Dev sessions (the user's idea, made precise)

- `sacli dev` makes a **dev session id** (not a chat session) and says so: `attach { dev: "dv_…" }`. It is kept as
  below, and stamped on every message from that person's connections — their tabs and sacli — while attached. Nobody
  else's messages ever carry it; the platform sets it from who is signed in.
- On the engine a dev session is a folder, `dev/<id>/`: an index of what it overrides (program name → build hash, agent
  and map bodies). Builds themselves live in the engine's one content-addressed store, so a dev build that equals a
  published one costs nothing.
- **Detach** (Ctrl-C, `sacli dev stop`) sends `dev:end`; the engine deletes `dev/<id>/` and the platform forgets it. If
  sacli dies, the session ends after 30 minutes without a heartbeat. Nothing of it remains: dev builds are never in the
  catalogue, never in R2, never published. The source is only ever the person's folder.
- **Several at once:** each person can have one dev session per project; two people's never see each other.

## Where development environments are kept (the user, 2026-10-13)

A dev session is a **development environment**: named (`sacli dev --env home-redesign`), several per person, resumable on
another machine, cleaning itself up.

- **The person's own Durable Object (UserDO) keeps the environment** — it is their work ("what is theirs — a module they
  build, all their work", 2026-10-04): its name, the full overrides (program name → build, agent and map bodies), where
  each changed source file is in R2 (by hash, saved on every save, so another machine can resume it), last used, and its
  clean-up timer. Their tabs already reach the project through it, so it attaches "my active environment" to each
  message it passes on. A key acts for the person who made it (and needs `project.develop`).
- **Making one asks the project first:** the UserDO asks the ProjectDO for permission (`project.develop`); the project
  checks it and, in the same step, writes the environment's row and gives its id — so the list starts where permission
  is given. Only then does the UserDO keep the detail.
- **The project's Durable Object keeps the list** — "never go to each user asking": every message passes through the
  project, so it records, one row per environment, updated in place: id, name, owner, the names it overrides, created,
  last used, status (active · inactive · closed). Closing it sets the status on that row. Project admins see the list
  in the console; the detail stays with the person.
- **The engine** keeps `dev/<id>/` (its builds), cleared when the environment ends.
- **Forgetting to detach:** with no sacli attached for 30 minutes the environment goes inactive — the person's tabs fall
  back to published — and stays to resume; unused for 14 days it is deleted with its R2 sources (warned first), or at
  once with `sacli dev delete <env>`.
- **Permission:** `project.develop` — make and use environments, without publishing (that is `project.publish`). In the
  Build group; admins hold it.
- This also settles the open question in platform-architecture.md (programs, *To agree*): a person's unfinished work is
  theirs (UserDO); what is shared is the project's. Dev builds never enter the project's catalogue.

## What runs where

- **Source:** the person's folder, always. sacli sends only the changed program's source (kilobytes) on a save.
- **Build and run:** the engine. The same compiler as publishing, next to the data, with the project's data access
  rules applied as that person. No database, data or infrastructure on the laptop; no localhost.
- **Screens:** the browser already draws each step with the build the session names, fetched from the engine by hash —
  the person's own tab simply names their dev build. Others' tabs never do.
- **Running the Node side on the laptop** (its data calls relayed to the engine) was weighed and left out: a program's
  server side runs inside the engine's STATE engine, between steps of a session; splitting it across a network on every
  call makes dev differ from production and slower. Sending a few kilobytes and building on the engine takes about a
  second — the "copy on every change" costs less than the relay would.

## Many versions on the engine, without bloat

The engine's program store becomes a **cache over R2**, not a record: everything published is in R2 by hash and can be
fetched again.

- **Kept:** each program's published build; every build a session opened in the last 14 days names; every build a live
  dev session names.
- **Removed:** anything else not used for 14 days (a nightly sweep), and a dev session's builds when it ends.
- **Missing when needed:** fetched from R2 by hash, checked against its hash — as a fresh engine does today.

So it works "as if everything is there" while only what is in use is.

## `sacli clone` — so the person and their AI know everything

```
<folder>/
  superatom.json        the project, the hub, what was cloned (each item's version)
  AGENTS.md             how to work here — for people and AI agents: commands, the rules (dev, publish), this project's
                        agents, programs and libraries with one line each, linking their doc.md
  map.json  knowledge/  agents/<name>.json
  programs/<name>/      every program AND library, with source and doc.md — "how do I use this library" is answered here
  platform/             read-only, at the platform's current version:
                          ui/        @superatom/ui as types + DESIGN-SYSTEM.md + a gallery of each component in use
                          program/   what a program's server side is given (query, STATE, intents…) as types
                          docs/      the program contract, the answer format (markdown with markers), examples
  package.json, tsconfig.json   @superatom/ui → platform/ui, @lib/<name> → programs/<name>: every import resolves,
                        `pnpm typecheck` works, an editor and an AI agent see every type
```

`sacli pull` brings it up to what is published (and refreshes `platform/` when the platform moved).

## `sacli dev`

```
$ sacli dev
  dev session dv_8k2… on proc-demo — only you see it; everyone else sees what is published
  ▸ watching programs/, agents/, map.json · Ctrl-C ends it
  today   built on the engine in 0.9 s ✓   (your tabs on proc.superatom.site show it now)
```

On a save: type-check locally (instant) → send the changed program's source → the engine builds it into the store and
writes it into `dev/<id>/` → the person's open tabs run their view again. Build errors and that person's server errors
and logs stream to the terminal. A bar in their browser says "Dev session · today · End".

## Publishing

`sacli publish "<what changed>"` (from the cloned folder, someone who may publish): each changed program built and
published, agents and the map written, the graph's draft published — one record of who, what and why.

## Consistency review — every kind, the same rules

| Kind | Published by default | Draft / vN | Dev session | Kept | Today |
|---|---|---|---|---|---|
| Concepts, domains | yes | yes | (draft) | graph, by hash | as the rule |
| Agents, map | yes | yes | planned | graph | as the rule |
| Programs | **yes (built today)** | draft: yes | planned | R2 by hash, engine cache | fixed today — was newest-of-all |
| The project app (`app/`) | **no — live at once** | no | no | R2 by hash | to fold into programs (below) |
| Dashboards | live at once (current + 5 builds) | no | no | R2 | to bring under the rule |
| Data connections, bridges | live at once | no | no | R2 / DO | stay live (they are settings, not versions) |

Inconsistencies found, to fix in order:

1. **Programs ran unpublished builds for everyone.** Fixed and deployed on the platform today; the engine side is in the
   engine release now building — it takes effect on a project when that project is switched to it.
2. **The project app goes live on publish, for everyone, with no draft and no per-person view.** Its screens
   (procurement's `home.tsx`) belong in programs — the `today` program's `web/` — where every rule above applies. Then the
   app keeps only what is truly the project's server, or nothing.
3. **Three places screens come from** (answer markers, a program's React blocks, the project app) → two: the answer,
   and a program's blocks.
4. **Two sources of a project's code** (the platform, and a GitHub copy) → one: the platform; `clone` gives the folder.
5. **The engine's program store only grows.** It becomes the cache above.
6. **Personal agents** (`user:` scope) read their newest, unpublished state — right for one person's own agents, and the
   one deliberate exception, named here.

## Order

1. Engine release with the published rule (building now), then each project switched to it.
2. The engine store as a cache (keep / sweep / fetch again).
3. `sacli clone` and `sacli pull`, with `platform/` and AGENTS.md.
4. Dev sessions: `attach`, the stamp, `dev/<id>/`, resolution through it, `dev:end`, the heartbeat; `sacli dev` with
   watch, build, reload of the person's tabs, logs.
5. `sacli publish`.
6. Fold the procurement app's screens into the `today` program.
