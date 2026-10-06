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
  organisation granted writing); with an organisation key (`sak_org_…`) also `create`, `grants`, `grant [--write]`, `revoke`
- organisation keys: a profile may hold one (the warehouse over HTTP, no background connection)
- the background connection: idle limit, lifetime limit, `status`, `disconnect`, cleanup on every way out
- `--json` on every command; help on every command; exit codes 0 done · 1 refused · 2 usage · 3 key refused · 4 network
- credentials kept mode 600, with a warning if others can read them; a key passed to the background process only
  through its environment
- zero runtime dependencies; one bundled file (`dist/sacli.mjs`, Node 22+)

**Planned (not built)**
- installing it: `curl -fsSL https://superatom.site/install | sh` picks the build for macOS, Linux or Windows from the
  platform's R2 releases (the latest by default, any version on request)
- `sacli engine install | upgrade | status`: installs and configures the Superatom engine for a project (Docker first)
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
