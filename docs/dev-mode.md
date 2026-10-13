# Developing a project: `sacli clone` and `sacli dev`

**Status: plan (2026-10-13), to agree before building.**

## In the user's words

"We go with sacli dev. Frontend code — this also runs in the published user UI. That's how we lazy load even in
production, so we don't want any localhost. We do `sacli dev` and it will use all our local agent's programs. I also want
a clone command, which will get all the required programs and platform code as well — otherwise if there is a library,
how will we know how to use it. It will really be like `pnpm dev`, and relay things from the local system through the
websocket to the hosted user UI. If that's not possible, we build each program and just reload proc.superatom.site to
see. Make sure that only the person doing dev sees their own version — the rest see the published version, so we never
disturb others. Like `wrangler dev` for a Cloudflare Worker, with one difference: there is no localhost, everything runs
in the engine — we don't want the database and infrastructure set up on the local machine again."

## The idea in one paragraph

The source lives on the developer's machine; everything else stays where it is. `sacli dev` watches the folder and, on
each save, sends the changed program to the project's engine, which builds it as **that person's dev build**. The
platform keeps, for that person only, a **dev overlay**: "for me, program `today` is this build". Every session that
person runs — in sacli or in the browser at proc.superatom.site — runs their builds on the engine, against the real
data; their browser draws their builds' screens, because a session already tells the app which build of each program
to draw and the app loads it by hash (as in production). Everyone else's sessions resolve to the published builds and
never see a dev build. Nothing runs on localhost; no database or data on the laptop.

## What exists, and must change first

- A session runs programs by name; the engine resolves a name to **the newest build on its disk, published or not**
  (`ProgramStore.resolve`). So today any build — anyone's unpublished draft — is live for everyone on that engine the
  moment it is built, and publishing a program changes nothing. (The procurement programs are all unpublished and live.)
- **Fix (step 0):** a name resolves to the newest **published** build, or to the asker's dev build. Migration, once: the
  build each program runs now is published, so nothing anyone sees changes on the day.

## `sacli clone [<folder>]` — the project as one folder

Everything needed to change it, understand it and type-check it locally — never data:

```
<folder>/
  superatom.json        the project, the hub, and what was cloned: each agent's and program's version (the base)
  AGENTS.md             how to work here, for people and AI agents: the commands, the rules (pull first, dev, publish),
                        this project's agents, programs and libraries with one line each, linking their doc.md
  map.json              the project's map (its sections; which agent is home)
  knowledge/            the graph (index.mts + its files) — the only source of knowledge
  agents/<name>.json    each agent: domain, programs, tools, look, starts
  programs/<name>/      every program AND library the project has — manifest.json, doc.md, server/, web/ — the source
                        of its live build (kept with every build since 2026-10-07)
  platform/             read-only, what programs are written against, at the platform's current version:
                          ui/       @superatom/ui as type declarations + DESIGN-SYSTEM.md (every component, its props)
                          program/  the server-side API a program gets (ctx: query, state, intents…) as types
                          docs/     program-contract.md, the answer format (markdown with markers)
  package.json, tsconfig.json   paths: @superatom/ui → platform/ui, @lib/<name> → programs/<name>, so an editor and
                        `pnpm typecheck` resolve every import, and an AI agent can read how a library is used
```

- Libraries come with their **source and doc.md**, so "how do I use this library" is answered by reading it.
- `platform/` is generated from our packages at release (types and docs only, no implementation); `sacli clone` and
  `sacli pull` refresh it, and say when the platform's version moved.
- `sacli pull` brings the folder up to what is live (refuses over local changes not pushed, unless told).

## `sacli dev` — like `wrangler dev`, with the engine instead of localhost

```
$ sacli dev
  developing proc-demo as vaishnavi@… — only you see these builds; everyone else sees the published ones
  today        built 3.1 s  (dev 9f2c…)   ✓ live for you
  ▸ watching programs/, agents/, map.json — Ctrl-C to stop (your builds are kept until you end dev)
```

1. **Watch** the folder. On a save: type-check that program locally (instant, catches most mistakes), then send its
   source to the engine — the build happens there, as today (`program:build`), marked **dev, owned by this person**.
   Libraries first when a library changed, and every program using it rebuilt.
2. **Overlay:** the platform records, per person, `{ program → dev build }` (and changed agents and map, below). It is
   theirs alone; it ends with Ctrl-C / `sacli dev stop`, or after 12 idle hours.
3. **Resolution:** every message from that person — any tab, any device, sacli — carries their overlay to the engine
   (the platform stamps it; the person cannot forge another's). The engine resolves names through it first.
4. **Reload:** the platform tells that person's open tabs "your build of `today` changed"; the tab runs the view again
   (the same thing as reloading proc.superatom.site, done for you). A few seconds from save to screen.
5. **Errors and logs:** a failed build prints its errors in the terminal; a dev build's server errors and log lines
   from that person's runs are streamed to the terminal (like `wrangler dev` tailing).
6. **In the browser:** a thin bar on every page — "Developing: today, award · Stop" — so it is never mistaken for live.
7. **Agents and the map:** a changed `agents/<name>.json` or `map.json` goes into the overlay the same way (seen only by
   them). **Knowledge** changes in dev use the graph's draft for that person's sessions (`--graph draft`, which exists).

## Publishing

`sacli publish "<what changed>"` — the dev builds become published, changed agents and the map are written, the graph's
draft is published; one record of who, what and why. Only someone who may publish. (Pull-first, history and rollback
follow later, on the same records.)

## Never disturbing others — the guarantees, each tested

- A dev build is never resolved for anyone but its owner (step 0 + the overlay).
- Only people who may publish can develop; an overlay names only builds they made.
- The overlay is set by the platform from the signed-in person, never from the message.
- Ending dev (or 12 idle hours) removes the overlay; dev builds are pruned (the newest few per person kept).
- Published builds, agents, the map and knowledge do not change until `sacli publish`.

## Not in this plan

- The procurement project's separate app (`app/web`, `home.tsx`): one server per engine, so it cannot be per person.
  The way through is to move its screens into the `today` program's `web/` (a block), where dev covers them.
- Branches and merging; pull-first versioning and rollback come after dev, on the same records.

## Order

0. A name resolves to the published build (or the asker's dev build); publish today's live builds once.
1. `sacli clone` and `sacli pull` (the folder above, with `platform/` and AGENTS.md).
2. `sacli dev`: dev builds, the per-person overlay, resolution through it, reload of the person's tabs, the dev bar.
3. Errors and logs streamed to the terminal; agents and the map in the overlay.
4. `sacli publish`.
