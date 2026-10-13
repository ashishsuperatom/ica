# Superatom — for AI agents

You are an AI agent (Codex, Claude, or any coding agent) asked to work with a **Superatom project**. You do it through
**sacli**, the Superatom CLI, holding an **agent key** a person gave you.

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

## 2. Your key

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

**Change an agent, or build a new one:**

```sh
sacli agent pull <agent> ./my-agent              # an existing agent as it is now: agent.json and its programs' source
sacli agent init ./my-agent                      # or a new one: agent.json, knowledge/index.mts, programs/<name>/
sacli agent push ./my-agent --reason "why"
sacli program build ./my-agent/programs/<name>   # built by the project's engine, kept by the platform
```

To change an agent that exists, always start from `sacli agent pull`, not from an older copy: it is what is live now,
so you never undo someone else's change. A push goes into the draft, like every change.

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
