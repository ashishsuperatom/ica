# What a person sees, and developing a project (`sacli clone`, `sacli dev`)

**Status (2026-10-14):** built — the published rule; `sacli clone` / `pull`; development environments (`sacli dev`, `dev
list`, `dev stop`, `dev delete`), each seen only by its owner, listed for administrators on the console's Engine page;
`sacli program publish`. Not built yet — 4b to 4e below: the record in the person's own Durable Object, knowledge in
environments, one kind of unpublished work, and `sacli publish`.

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
the person's attached environment (if any)  →  base: published  |  vN  →  not found
```

- **Base, published** — what everyone gets, always, unless they ask otherwise.
- **Base, a version (vN)** — asked for by someone who may publish (`sacli ask --graph v3`, `session:open graph`): the
  knowledge as it was published then. Usable any time; kept by the session.
- *(Transitional, removed when environments land: `--graph draft` — the shared knowledge draft, and with it programs'
  newest unpublished builds. Both become the person's environment; see "One kind of unpublished work".)*
- **An attached environment** — an overlay on top of the base, only for its owner, only while attached: "in my
  environment the program `today` is this build, the agent `today` is this". What it does not name falls through.

A session records the layers it was opened with, so it keeps meaning the same thing (as it keeps its program hashes).

## Development environments

(The user's idea of a dev session — "a folder dev-<id> on the engine, programs picked from it first, published ones when
not, cleared when we detach" — made a named, lasting environment, 2026-10-13. The user's first words had everything
stay in the local folder; a later decision — resume on another machine — keeps the sources in R2 as well.)

**What it is.** Named (`sacli dev --env home-redesign`); a person may have many in a project and is attached to at most
one at a time. It names what it overrides — programs (each a build, from sources), agents, the map — and nothing else.

**Who keeps what:**

| | keeps | why |
|---|---|---|
| the person's **UserDO** | the environment itself — the **source of truth**: its name, every override in full, where each changed source file is in R2 (by hash, saved on every save), when it was last used | it is their work ("what is theirs — a module they build, all their work", 2026-10-04) |
| the **ProjectDO** | a **reference row** per environment: id, name, owner, the names it overrides, created, last used, status (attached · detached · deleted); and, while attached, the overrides the engine needs | it manages the engine and decides every message, so it already sees everything; admins see the list in the console; it never asks users |
| the **engine** | `dev/<id>/` while attached: the builds the environment names | it runs them, next to the data |
| **R2** | the environment's source files, by hash, until the environment is deleted | so any machine can resume it |

**Every change is an explicit request from the UserDO to the ProjectDO** — *create*, *attach*, *detach*, *delete* —
each checked against `project.develop` as it is made. Asking whether one may develop writes nothing.

- *create* — the UserDO makes the environment; the project writes its row (detached).
- *attach* — the UserDO sends the environment's overrides; the project marks the row attached, has the engine build
  what is not built into `dev/<id>/` (from the sources in R2), and from then on **stamps the environment on every
  message from that person** — their tabs (through the UserDO) and their keys (sacli, through the same door: the UserDO of the person the key acts for) alike.
  Stamped from the project's own row: nobody can name another's environment.
- *on each save* (sacli dev) — the changed source goes to R2 and into the UserDO's environment, and the project has the
  engine rebuild that program; the row's last used moves.
- *detach* — Ctrl-C, `sacli dev stop`, or **an hour with no sacli connected** (the same hour as sacli's background
  connection): the project stops stamping, has the engine clear `dev/<id>/`, marks the row detached. The person's tabs
  are on published again. The environment stays.
- *delete* — only by its owner (`sacli dev delete <env>`) or a project admin: the project clears the engine and marks
  the row deleted; the UserDO removes the environment and its R2 sources. **Never deleted for being unused.**

**Permission:** `project.develop` — make and use environments, without publishing (that is `project.publish`). In the
Build group; admins hold it. A key acts for the person who made it and needs it too.

This also settles the open question in platform-architecture.md (programs, *To agree*): a person's unfinished work is
theirs (UserDO); what is shared is the project's. Builds made in an environment never enter the project's catalogue.

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

- **Kept:** each program's published build; every build a session opened in the last 14 days names; every build an
  attached environment names.
- **Removed:** anything else not used for 14 days (a nightly sweep); an environment's builds when it is detached (they are
  built again from its sources on the next attach).
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

## Giving someone development access

Every person develops **as themselves**, so their environments, builds and records are theirs and only their browser
shows them. A key acts as the person who made it — never hand someone your own key.

1. The project's administrator adds them (Access and roles) with the **Developer** role — view, ask, develop in an
   environment of their own; it publishes nothing.
2. They run `sacli login --browser --profile <name>`: their browser opens, they sign in with their own account and
   allow sacli, and sacli gets **a key of their own** for the project — acting as them, never holding more than their
   role, expiring in 90 days. (OAuth 2.0 for native apps, RFC 8252, with PKCE and a state sacli checks; sacli listens
   only on 127.0.0.1, for one callback; the sign-in token is used once and never saved.)
3. `sacli clone`, then `sacli dev`. `sacli dev list`, `stop <name>` and `delete <name>` work anywhere, no clone needed.

**Stop keeps, delete removes.** `sacli dev stop`, Ctrl-C, or an hour without sacli: the environment is detached and kept —
`sacli dev` resumes it (rebuilt from the clone). It is never deleted for being unused. `sacli dev delete <name>` (asked
first; `--yes` for scripts), or Delete in the console: it is gone — its record removed from the platform (the audit keeps
that it was deleted, by whom), its builds removed from the engine at once (a build the platform also holds stays). The
clone's files, on the person's computer, are theirs and stay.

**What it holds is what differs.** A build identical to what is published now (a name's newest published build) is not
a change: `sacli dev` says so ("the same as published") and leaves it out, so the card — "Your test version · <name>" —
says only what this person sees that everyone else does not, or that nothing differs yet.

**Stopped from where it is seen.** The environment card in the workspace (the amber dot, opened) has Stop and Delete
(each asks once more first, so a stray click does nothing): the person sees they are in one and decides. Stopped or
deleted anywhere — the card, another terminal — the project tells that person's `sacli dev` at once (`dev:ended`, named
`dev:<environment id>` so it reaches the right one through the shared background connection) and it ends, saying why.
Nothing else ends it — never idleness, never a guess.

## `sacli dev`

```
$ sacli dev --env home-redesign
  environment home-redesign on proc-demo, attached — only you see it; everyone else sees what is published
  ▸ watching programs/, agents/, map.json · Ctrl-C ends it
  today   built on the engine in 0.9 s ✓   (your tabs on proc.superatom.site show it now)
```

On a save: type-check locally (instant) → send the changed program's source → the engine builds it into the store and
writes it into `dev/<id>/` → the person's open tabs run their view again. Build errors and that person's server errors
and logs stream to the terminal. A bar in their browser says "Environment home-redesign · today · Detach".

## Versions are snapshots, not git (the user, 2026-10-13)

"We will not go for the complexity of full git — just a snapshot at any point. If the user wants to maintain their own
git, they can; we think of them as versions, apply any or roll back. Let's keep it simple — I don't want to build another
Git platform." So: every publish is a version (a snapshot: knowledge, agents, map, program builds); any version can be
applied again (a rollback is publishing an older snapshot as the next version); there is no merging and no branches. A
clone is an ordinary folder — people who want history of their own keep it in GitHub or anything else. `pull` refusing to
overwrite local edits is the only safeguard, and it is a plain file comparison.

## Publishing

Today a change goes live through the draft: `sacli program build` then `sacli program publish <name>`; `sacli agent push`
and `sacli graph import` then `sacli graph publish`. Planned (4e): `sacli publish "<what changed>"` (someone who may
publish): the attached environment's changes become published — its
program builds published, its agents, map and concepts written as the next knowledge version — one
record of who, what and why. The environment then carries on from what is published.

## Consistency review — every kind, the same rules

| Kind | Published by default | Draft / vN | Environment | Kept | Today |
|---|---|---|---|---|---|
| Concepts, domains | yes | versions: yes | planned (environment) | graph, by hash | shared draft until environments |
| Agents, map | yes | versions: yes | planned (environment) | graph | written to the shared draft until environments |
| Programs | **yes (built today)** | — | planned (environment) | R2 by hash, engine cache | fixed today — was newest-of-all; catalogue drafts until environments |
| The project's views | yes — a library (`@lib/views`, 2026-10-14) | — | yes, like any program | R2 by hash | done |
| Dashboards | live at once (current + 5 builds) | no | no | R2 | to bring under the rule |
| Data connections, bridges | live at once | no | no | R2 / DO | stay live (they are settings, not versions) |

Inconsistencies found, to fix in order:

1. **Programs ran unpublished builds for everyone.** Fixed (platform and engine, 2026-10-13).
2. ✓ (2026-10-14: the app is the views library) **The project app went live on publish, for everyone, with no draft and no per-person view.** Its screens
   (procurement's `home.tsx`) belong in programs — the `today` program's `web/` — where every rule above applies. Then the
   app keeps only what is truly the project's server, or nothing.
3. **Three places screens come from** (answer markers, a program's React blocks, the project app) → two: the answer,
   and a program's blocks.
4. **Two sources of a project's code** (the platform, and a GitHub copy) → one: the platform; `clone` gives the folder.
5. **The engine's program store only grew.** Now the cache above (built; with the engine release).
6. **Personal agents** (`user:` scope) read their newest, unpublished state — right for one person's own agents, and the
   one deliberate exception, named here.

## One kind of unpublished work (decided 2026-10-13: "when possible, create one")

Unpublished work — a program, an agent, the map, a concept — exists **only in its author's environment**. What
is shared is only what is published. So:

- `sacli program build` and `sacli agent push` build **into the person's attached environment** (they attach one if
  none is); the project's catalogue holds only published builds and their history. Catalogue drafts go.
- `sacli publish` moves an environment's changes to published, as one record; a new environment then starts from what
  is published.
- **Knowledge too (decided 2026-10-13):** the console's edits go into the editor's own environment, instead of the
  shared draft — the same overlay for concepts — and publishing makes the next version. The shared draft goes when
  environments are built.
- A chat session opened in an environment names builds that exist only there: it belongs to the environment, is shown
  only to its owner, and after the environment is deleted stays readable (answers kept) but runs no further step.

What this replaces in what is built today (to remove as environments land): catalogue drafts and their publish-by-hash
from sacli (`program:publish` of a draft); `--graph draft` running programs' newest builds; the shared knowledge draft.

## Order

1. ✓ Engine release with the published rule; every project runs it.
2. ✓ The engine store as a cache (keep / sweep / fetch again) — built 2026-10-13: a build marked used as it runs, a daily
   sweep of builds unused 14 days (never the newest published, never a linked library), fetched again by hash.
3. ✓ `sacli clone` and `sacli pull`, with `platform/` (the SDK, released as the product `sdk`) and AGENTS.md — built
   2026-10-13 (replacing `agent pull`, which wrote a second folder layout). `agent push agents/<name>.json` from a clone.
4. Development environments:
   - 4a ✓ (2026-10-13) `project.develop`; create / attach / detach / delete / list as requests; the project's row and
     its stamp on the owner's messages (sacli and browser); builds into `dev/<id>/` on the engine (never uploaded, kept
     by the sweep while attached, cleared when it ends); agents, the map and programs read through it; `sacli dev`
     (watch, rebuild, Ctrl-C detaches); the hour's detach; the console's list (Engine page) with an administrator's
     delete. The detail is held in the project's row for now; 4b moves it.
   - 4b the record moved to the person's own Durable Object — `person:<org>:<personId(owner email)>`, reached from the
     owner's email with no mapping (docs/platform-architecture.md, who a person is) — sources in R2, resume on another machine.
   - 4c the browser: the environment's bar, and the person's tabs running their view again on a build.
   - 4d knowledge in environments (concepts overridden the same way); the shared draft removed.
   - 4e one kind of unpublished work: `program build` / `agent push` into the environment; catalogue drafts and the
     draft's programs removed.
5. `sacli publish`.
6. Fold the procurement app's screens into the `today` program.
