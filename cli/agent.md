# Superatom — for AI agents

You are an AI agent (Codex, Claude, or any coding agent) asked to work with a **Superatom project**. You do it through
**sacli**, the Superatom CLI, signed in **as the person you work for** — their own key, never someone else's.

## What Superatom is

A decision-intelligence platform. A project has **agents**: each is a domain of the project's knowledge (concepts,
composed into its prompt), the **programs** it may run (a Node bundle and a React bundle each), one **STATE** (a JSON
object the programs change), and a starting screen. People ask in words or click; answers are markdown.

- **Knowledge lives only in the composition graph.** Change it by exporting, editing, importing to the draft, trying the
  draft, then publishing — never by writing anywhere else.
- **Data only through the project's data sources.** Never hard-code numbers; concepts hold meaning, queries give numbers.
- **Everything you do is checked like a person's and recorded** in the project's audit history, under your key.

## 1. Install

Needs Node.js 22 or newer.

```sh
curl -fsSL https://get.superatom.site/sacli/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"     # if the installer said it is not on PATH
sacli --version
```

Upgrade with `sacli upgrade`; a given version with `sacli upgrade <version>`.

## 2. Signing in — as the person

**The usual way: the person signs in, you run the command.**

```sh
sacli login --browser --project <name> --profile <name>
```

It opens their browser (and prints the address, in case it does not open): **tell the person to sign in with their own
account and click Allow.** You cannot click it for them, and must not try. sacli then holds **a key of their own** for
that project — it acts as them, never holds more than their role there, and expires in 90 days. Everything you do is
then theirs: their development environments, seen only in their browser, and the audit history under their name.

- To develop, the person needs the **Developer** role (or one with `project.develop`) in the project — if a command is
  refused for a missing capability, ask them to have the project's administrator give it; do not look for another way.
- **Never use a key someone else made for them.** A key acts as the person who made it: work done with another person's
  key is that person's — their environments, their name in the audit.

**Or a key the person hands you** (an automation, a server without a browser):

A key looks like `sak_<project>_<secret>` (a project's) or `sak_org_<org>_<secret>` (an organisation's). It holds a set
of capabilities (`project.view`, `project.ask`, `project.publish`, …) and can never do more.

- **Never print, echo, log or commit the key.** Do not put it on a command line others can see; do not paste it into
  files in the repository.
- Prefer the environment: `SACLI_KEY` is used as given and never written anywhere. Or save it once from stdin:

```sh
printf %s "$SACLI_KEY" | sacli login     # checked with the platform, saved readable only by you
sacli whoami                             # which project, and what the key may do
```

A refused key exits with code 3: it was revoked or expired — ask the person for a new one; do not retry.

## 3. Find your way

```sh
sacli --help                  # every command
sacli <command> --help        # a command's options — the authority; this page is a summary
sacli agents                  # the project's agents
sacli map                     # the sections and places people see
sacli activity                # what is running for you
```

Add `--json` to any command for machine-readable output. Exit codes: 0 done · 1 refused or failed · 2 bad usage ·
3 the key was refused · 4 network or timeout. A refusal says what was missing (often a capability) — report it to the
person rather than working around it.

## 4. Common work

**Ask and work in sessions** (`project.ask`):

```sh
sacli ask "which orders are late this week?"
sacli session open <agent>                       # prints a session id
sacli session get <session>
sacli session intent <session> --call <package>.<fn> --param name=<json>
sacli session intent <session> --set <path>=<json> --to new
```

**Change knowledge** (`project.publish`) — the graph is the only source:

```sh
sacli graph export ./knowledge                   # the draft, as a working copy (index.mts + files)
# edit ./knowledge/index.mts — one concept per idea, said once; meaning, rules, joins, traps — never data snapshots
sacli graph import ./knowledge/index.mts --reason "why this change"
sacli ask --graph draft "a question the change should answer"   # try the draft before publishing
sacli graph draft                                # what is not yet published
sacli graph publish "what changed"               # people and agents use it from now on
```

Every change to knowledge, agents and the map (`sacli map set`) goes into the **draft**. Nobody sees it until the
draft is published. Publish only when the person asked for it, or ask them first.

**Change the project — start from a clone:**

```sh
sacli clone ./project                            # the project as it is published: agents/, programs/ (with libraries),
cd project                                       #   knowledge/, map.json, platform/ (types and docs), AGENTS.md
pnpm install && pnpm typecheck                   # every program checked against the platform's types
sacli pull                                       # before changing anything: bring it up to what is published
sacli dev                                        # the person's environment: what you change is built on the engine and
                                                 #   seen only by them (sacli and their browser); everyone else sees what
                                                 #   is published. Keep it running: every save rebuilds. Needs
                                                 #   project.develop.
# edit programs/<name>/ (server/, web/), agents/<name>.json, map.json …
sacli ask "…" · sacli session open <agent>      # try it — the environment applies to the person
sacli publish '<what changed>'                   # make it live: shows exactly what it will do, then asks
```

**Ask the person before anything that starts, ends or publishes — sacli asks too, and you pass `--yes` only after
they said yes:**

- `sacli dev` makes a **new** environment only on a yes (it shows the name — after the folder — and the project).
  Resuming an existing one asks nothing.
- `sacli dev stop [<name>]` (or Ctrl-C) **detaches and keeps** it: the person sees what is published again; `sacli dev`
  resumes it. An hour without sacli does the same. An environment is never deleted for being unused.
- `sacli dev delete [<name>]` **removes it for good** — its record and its builds; the clone's files stay. Asked first.
- `sacli publish` shows what goes live (programs built and published, knowledge, agents, the map) and asks. It refuses a
  draft already holding someone else's unpublished changes unless the person knowingly adds `--with-draft`.

`sacli dev list`, `stop <name>` and `delete <name>` work anywhere — no clone needed. `sacli dev --once` builds and
checks, then detaches. Knowledge is not part of an environment yet: try a knowledge change with `sacli ask --graph
draft` (above).

Read `AGENTS.md` and `platform/docs/program-contract.md` first: they say what a program is, and what each library and
component offers. Always start from `sacli pull`, never from an older copy, so you never undo someone else's change.
A push goes into the draft, like every change. (`sacli agent init ./my-agent` makes a new agent's folder.)

**Data:**

```sh
sacli datasources list
sacli warehouse tables
sacli warehouse query "select … limit 100"       # read-only; keep results small, totals in the query
```

**Anything else** the console can do: `sacli api <METHOD> <path> [--data '<json>']` calls the platform's REST API with
your key, under the same checks.

## 5. Working well

- Read `sacli <command> --help` before using a command you have not used in this session.
- Make one change at a time, check it (`sacli ask --graph draft`, `sacli session get`), then the next.
- Give every change a `--reason` a person will understand later; it is kept in the history.
- Show people plain results, not internal names, tables or stack traces.
- Stop and ask the person when a command is refused, when a change would remove or overwrite something, or when the
  next step is not clearly what they asked for.
