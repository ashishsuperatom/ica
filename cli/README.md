# sacli — the Superatom CLI

A CLI for working with Superatom through a **key**: an organisation's (`sak_org_<org>_…`) or a project's
(`sak_<project>_…`). It's mainly for AI agents (Codex, Claude, or any coding agent), and works for people too. A person
makes the first key in the admin console; a key holding `org.keys` / `project.keys` makes keys below it. A key holds
capabilities (the names roles use), never more than its maker holds now; when a key goes, the keys it made go with it.
Everything `sacli` does is checked like a person's and recorded in the audit history. The backend knows nothing about the CLI: it knows
agent keys and the agent connection, and any system may use them. `sacli` is our client.

```
printf %s "$KEY" | sacli login            # check the key with the hub and save it (mode 600)
sacli agents
sacli session open vehicle-trips
sacli session intent <session> --call trips.run
sacli session intent <session> --set trips.branch=HYDERABAD --to new
sacli ask "which trips are unsettled?"
sacli disconnect
```

## A new project, start to finish

The order every new project goes through, with the commands. Names in `<…>` are yours.

**1. Organisation and project.** Made by a person in the admin console. A project belongs to one organisation.

**2. Two keys, two profiles.** They do different jobs, and both live side by side in the credentials file:

| Key | Made in the console under | Holds | Used for |
|---|---|---|---|
| project key (`sak_<project>_…`) | the project → Keys | `project.view, project.ask, project.data, project.connect, project.publish, project.manage` | everything inside the project: its engine, sources, index, agents, questions, the warehouse tables it was granted |
| organisation key (`sak_org_…`) | the organisation → Keys | `warehouse.manage, warehouse.query, warehouse.write` | the organisation's warehouse (SA-WAREHOUSE): loading tables and granting them to projects |

```
mkdir -p <folder> && cd <folder>
pbpaste | sacli login --profile <project>          # the project key, from the clipboard (never typed or printed)
sacli use <project> --here                         # this folder means this project (.sacli.json)
pbpaste | sacli login --profile <org>              # the organisation key; used with --profile <org> only
sacli whoami && sacli profiles
```

**3. The engine.** In Docker by default (on any OS), or `--native` under PM2. What it connects with comes from the
platform; nothing is pasted.
```
sacli engine start                                 # waits until the hub has it
sacli engine status
sacli engine logs -f                               # look for ENGINE FULLY READY
```

**4. Data into SA-WAREHOUSE.** A DuckDB database, a CSV or an Excel workbook, from this machine straight to the
platform (no engine involved). `--project` grants each table to the project.
```
sacli warehouse load <file.duckdb | file.csv | file.xlsx> --project <project id> --profile <org>
sacli warehouse load <file> --replace --project <project id> --profile <org>   # the file regenerated: load it again
sacli warehouse tables                              # what the project can now see
```
Every project has SA-WAREHOUSE as a data source already (`sacli datasources list`); other sources are connected with
`sacli datasources create`.

**5. The index**, so agents find the tables:
```
sacli dsi build SA-WAREHOUSE
sacli dsi status --watch
sacli dsi stats
```

**6. Work with it** through the project key: `sacli ask`, `sacli agents`, `sacli session …`, and the knowledge and
programs commands.

## How it connects

- **A key belongs to one project or one organisation; a profile holds one key.** The profile in use is chosen in this order: `--profile`,
  then `$SACLI_PROFILE`, then the nearest `.sacli.json` in this folder or above, then the default. `sacli profiles`
  lists the profiles, and `sacli use <profile> [--here]` switches between them.
- **One background connection per project.** The first command starts a small background process that holds the
  project's WebSocket. Later commands reach it over a local socket in a directory only you can enter, named by a hash
  of key and hub (never the key itself).
  - It closes after an hour with no command, and each command resets the hour. It never lives longer than a day.
  - When it stops, it closes the connection, removes its socket and exits. That holds for idling, `sacli disconnect`,
    a signal or a crash. A socket left by a killed process is detected and replaced.
  - `--no-daemon` (or `$SACLI_NO_DAEMON=1`) connects for one command only.
- Large replies arrive in parts or as parcels. They are made whole by the platform's own transport, the same as in the
  browser.

## Features

**Built**
- `login` (key from `--key`, `$SACLI_KEY` or stdin, checked before it is saved), `logout`, `whoami` (masked key)
- profiles, one key each: `profiles`, `use [--here]`, a per-folder `.sacli.json`
- with an organisation key: `projects list | create | delete | restore`; with any key holding the keys capability:
  `keys list | create [--save-as <profile>] | revoke` (`--project <id>` for a project's keys from an organisation key)
- `api <METHOD> <path> [--data]`: the platform's REST API with the key, the same routes and checks as the console
- `agents`; `session open | get [--as-of] | intent | goto`; `ask` (with live narration on stderr)
- `warehouse tables | query | append` with a project key (its grant; appending needs `warehouse.append` and a table the
  organisation granted writing); with an organisation key (`sak_org_…`) also `load` (DuckDB, CSV, Excel), `create`,
  `grants`, `grant [--write]`, `revoke`
- `engine start | status | stop | logs`: the project's engine in Docker (default) or `--native` under PM2
- `datasources …` and `dsi …`: the project's sources and their index
- organisation keys: a profile may hold one (the warehouse over HTTP, no background connection)
- the background connection: idle limit, lifetime limit, `status`, `disconnect`, cleanup on every way out
- `--json` on every command; help on every command; exit codes 0 done · 1 refused · 2 usage · 3 key refused · 4 network
- credentials kept mode 600, with a warning if others can read them; a key passed to the background process only
  through its environment
- one bundled file (`dist/sacli.mjs`, Node 22+); one runtime dependency, DuckDB's official Node package, loaded only by
  `warehouse load`

**Planned (not built)**
- installing it: `curl -fsSL https://superatom.site/install | sh` picks the build for macOS, Linux or Windows from the
  platform's R2 releases (the latest by default, any version on request)
- the agent HTTP API, with the key: domains and concepts (create, edit, suggest), programs (build, upload, publish), and
  what usage shows is missing
- organisation keys for creating projects
- `sacli update` (self-update), and a notice when a newer version exists
- shell completion (bash, zsh, fish, PowerShell), and a man page
- the key in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret), with the file as the fallback
- `--verbose` / `--debug` logging, `--output table|json|ndjson|yaml`, `--quiet`
- `sacli watch <session>`: follow a session's changes live
- proxy support (`HTTPS_PROXY`) and custom CA certificates for corporate networks
- reconnecting with backoff during a long command
- `sacli config get|set` for defaults (hub, timeout, output)
- standalone binaries (no Node needed), signed and with checksums
