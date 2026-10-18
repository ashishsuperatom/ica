# Deploying the engine

How a change to the engine reaches a project's box — the one process, written down so it is always followed. The
platform (the control plane on Cloudflare) has its own: `scripts/deploy-control-plane.sh` (CLAUDE.md). Knowledge,
programs and data never go through this path: they reach engines from the platform, continuously.

**Two things are updated, by two paths:**

| | What | How it reaches a box | How fast | Restart |
|---|---|---|---|---|
| the application | programs (Node + React bundles), agents, knowledge (the graph), the map, settings, connector bridges | published to the platform (`sacli program build`, `sacli graph import`, the console); stored by hash; the engine downloads it | seconds | no |
| the engine | our runtime code, Node, the agent CLIs | this document: an image built by GitHub Actions, pulled from registry.superatom.ai | under a minute | yes, ~10–20 s |

Almost every change is the first path. This document is the second.

Decided 2026-10-10 with the user: standard container images, built only by GitHub Actions from `dev`, stored as plain
files in our own R2 bucket, pulled by digest. One engine runs per project, never two at once; up to a minute of downtime
for a switch is acceptable. Restricted sites reach only `*.superatom.ai` and `*.superatom.site`.

## Names

On a machine: `superatom-<project name>` (the engine), `superatom-<project name>-updater`, `superatom-<project name>-data`
(its volume) — each labelled `superatom.project=<id>` and `superatom.role=engine|updater`, which is how sacli and the
installer find them (an earlier install's `sa-engine-<id>` is found the same way, and its volume kept).

Each name says its layer; the words mean one thing each:

| Layer | Name | What it is | Changed by |
|---|---|---|---|
| 1. Host | **Superatom Engine installer** (`get.superatom.site/engine/install.sh`) | the one-time installer: Docker if missing, then the engine and its updater | running it once per machine (again only to move a project to another machine) |
| 2. Engine | **Superatom Engine** (container `superatom-<project name>`) | our runtime: the engine's code, Node, the agent CLIs | an **engine release** |
| 3. Engine updater | **Superatom Engine Updater** (container `superatom-<project name>-updater`) | switches the Engine to the release chosen for the project | the installer (run again: made again, data kept) |
| 4. Project content | **project content** | programs, agents, knowledge, map, settings, bridges | **publishing** to the platform; synced live, no updater |
| — | **Superatom Platform** | the control plane on Cloudflare | `scripts/deploy-control-plane.sh` |

**Release** is only ever an engine build; **publish** only ever project content; **setup** only ever the host.

## The map

```
 developer / agent                GitHub (ashishsuperatom/ica)                Cloudflare R2 (superatom-registry)
 ─────────────────                ────────────────────────────                ──────────────────────────────────
 commit on dev
 git push origin HEAD:dev ──────► workflow "engine" (.github/workflows/engine.yml), on dev only — two jobs side by side:
                                   ├─ check   pnpm install --frozen-lockfile (6 parts) → scripts/check-all.sh
                                   └─ image   (environment "registry" — dev only)
                                       ├─ build   Dockerfile, linux/amd64, layers cached by GitHub
                                       └─ push    scripts/registry-push.sh ──────────► v2/superatom-engine/blobs/sha256:…
                                                  (only the layers not there; read back     v2/superatom-engine/manifests/<digest>
                                                   through the domain) — by digest ONLY:
                                                   nobody can choose an image with no name
                                  then, only if both passed:
                                   release ├─ name    scripts/registry-name.sh: the image's     v2/superatom-engine/manifests/dev-<date>-<commit>
                                           │          label superatom.build = the commit (read     v2/superatom-engine/manifests/dev
                                           │          from the registry, a few kilobytes), then its names
                                           ├─ to Fly  scripts/registry-to-fly.sh (same digest, only the layers Fly lacks)
                                           └─ the installer, get.superatom.site/engine
                                                                                         served as files at
                                                                                         https://registry.superatom.ai
 a project's box  ◄──────────────────────────────── docker pull registry.superatom.ai/superatom-engine@sha256:<digest>
   superatom-<project name> (one container, data on its volume)          … the digest the platform pins for that project
```

Nothing runs behind `registry.superatom.ai`: it is the bucket's custom domain serving the files `docker pull` asks for.
`registry.superatom.site` serves the same files through the platform's Worker (read-only; docs/releases.md), for sites
that reach only `*.superatom.site`.
Slob's bucket (`frontend-packages`, `dl.superatom.ai`) is separate and untouched.

## What is in the image, and what is pinned

The image is layered so a release is small: what changes rarely first, our code last.

| Layer | Holds | Changes when | Pinned by |
|---|---|---|---|
| base | Debian 12, Node 22.23.3 | the base digest is moved by hand | `node:22-slim@sha256:…` in the Dockerfile |
| system packages | python3, g++, git, curl, jq | `DEBIAN_SNAPSHOT` is moved by hand | snapshot.debian.org at that date |
| tools | Claude Code, tsx | `vm/docker/tools/package.json` is edited | that file + its lockfile |
| dependencies (~1 GB) | node_modules incl. opencode, codex, pi | a lockfile or package.json changes | `vm/pnpm-lock.yaml`, exact versions, `--frozen-lockfile` |
| code (~6 MB) | `vm/apps`, `vm/packages`, `clients/*.ts` | every release | the commit (`/app/BUILD_ID`) |

Nothing updates itself: `DISABLE_AUTOUPDATER=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` in the image, and on every claude and
opencode the engine starts. Every GitHub Action is pinned to a commit. Upgrading anything is a deliberate change to a
pinned number, tested by a release like any other.

## Names

- **`dev-<date>-<commit>`** — each build's own name. Never moves.
- **`dev`** — the newest dev build. Moves.
- **`prod`** — the build approved for production: set by promoting a tested build (the same digest — never a rebuild).
- **Boxes run a digest** (`@sha256:…`), never a moving name: what a box runs changes only when its pin changes, and the
  previous digest is always there to go back to.

## Who can publish

- Only pushes to `dev` build, and only the repository's owner can push.
- The R2 key (Object Read & Write on `superatom-registry` only) lives in the GitHub environment `registry`, which only the
  `dev` branch may use: secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; variables `R2_ENDPOINT`, `R2_BUCKET`.
- Nothing can write through `registry.superatom.ai`: the domain only serves files.

## Releasing — the steps

1. Commit; run `scripts/check-all.sh` (CLAUDE.md: before every push).
2. `git push origin HEAD:dev` — pushing releases nothing by itself (since 2026-10-18).
3. On the development machine (superatom-forge), in the background: `scripts/release-engine-local.sh`. It runs every
   check, builds on that machine's Docker, puts the image into the registry, pulls it back to confirm it is that commit,
   publishes its installer, and asks GitHub to copy it into Fly's registry (the engine workflow with `copy_to_fly`, a minute). Its last lines name the release and digest.
   The R2 key is read from `~/.config/superatom/registry.env` there. The backup is GitHub's engine workflow, run by hand:
   Actions → engine → Run workflow (branch `dev`), or `gh workflow run engine.yml --ref dev`.
4. Put it on a project — **per project, in the admin console**: the project → Operations → **Engine version** → the
   version → *Switch to this*. Or `SACLI_PROFILE=<project> sacli engine switch dev-<date>-<commit>`. Both need project.manage.
   The page shows what is chosen, what the engine runs, and how the last switch went.
5. **Rollback**: choose the previous release the same way. Its image is still on the box: no download.

A new box — once, on the machine itself (it needs only `curl`; Docker is installed if missing):

```
curl -fsSL https://get.superatom.site/engine/install.sh | sh -s -- <a key of the project holding project.manage>
```

The script (`vm/apps/updater/install.sh`, published with every engine release) pulls the newest engine image only to run
its installer (`apps/updater/install.mjs`), which asks the platform for the engine's credentials and the release chosen for
the project, pulls that release by its digest, and starts the engine and its updater. The key is used once and never kept
on the box. From then on the updater switches the engine whenever another release is chosen — nobody logs into the box
again. No sacli and no Node on the box: sacli is for people and agents developing.

**Docker comes only from us.** A machine without Docker gets Docker's official static binaries from
`get.superatom.site/docker` — with or without the internet, the same everywhere — checked against the SHA-256 pinned in
`install.sh` (Docker publishes none), installed into `/usr/local/bin` and run as the `docker` systemd service. The version
and its checksum are written only there; the `docker-mirror` workflow publishes that version when they change. Needs
x86_64 Linux with systemd and iptables; a machine that already has Docker keeps its own.

## How a switch happens on the box

```
admin console / sacli engine switch ──► platform (ProjectDO): checks registry.superatom.ai serves it, keeps the choice
                                          │  pushed now (engine:release), and given again in every welcome
                                          ▼
 superatom-<project name>   writes <project home>/engine-release/desired.json
 superatom-<project name>-updater  (Docker socket + the engine's volume) reads it, every 10 s:
                         1. pull the image                 — fails: "refused", nothing changed
                         2. stop the engine (60 s to finish)  — one engine at a time, never two
                         3. copy its db/ folder aside
                         4. start the new engine, same volume, settings and restart rule
                         5. wait 90 s for it to reach the platform (it writes running.json)
                         6. up: old container removed, newest 3 images kept
                            not up / crashed: its last log lines kept, db/ restored, previous engine started again,
                            and that release is not retried until a different one is chosen
                       each step POSTed to the platform as it happens (engine key) ──► the switch record, whole on reload
                         ├─► admin console: every step with its time (Operations → Engine version)
                         └─► people with a tab open now: "Updating to a newer version · started 13:28"
                       and result.json on the box, which the engine reports again whenever it changes
```

- The updater runs from the engine image (`node /app/apps/updater/updater.mjs`) — plain Node and Docker's API, nothing
  installed. It is (re)made by the installer; it does not update itself.
- An engine stopped on purpose (`sacli engine stop`, which takes the updater away first) stays stopped.
- If the updater dies mid-switch, its next look finds the previous engine set aside and puts it back.
- Only releases from `dev-20261010-5ff39c5e` on can be switched to: an earlier one never reports that it came up, so it
  is started and then rolled back after 90 s (seen on the demo box: it reached "idle, waiting for questions" and was
  still rolled back, by design). Operator notes for the updater: `vm/apps/updater/README.md`.

## On Fly

Where a project has no machine of its own, its engine can run on Fly. **A machine there costs money, so the platform's
administrators decide, per organisation** (platform console → the organisation → Settings → Engines on Fly): whether its
engines may run on Fly, how many machines at most, and whether a new project gets its engine there when it is made. No
one else can change that. Within the allowance, someone holding project.manage places a project's engine
(`sacli engine start --fly [--region <code>]`): it claims one of the organisation's machines first — refused when Fly is
not allowed or all are in use — and gives it back when it leaves (`sacli engine stop --fly`).

A Fly machine is itself a container, so nothing is installed there and no updater runs beside it: **the platform** (the
project's ProjectDO, with its Fly token) does what the installer and the updater do.

```
sacli engine start --fly ──► platform: is the release (chosen, else the newest) in registry.fly.io? — no: refused,
                              │        "Actions → engine, copy_to_fly …"
                              ├─ the app superatom-<project name> (its id beside it if another holds the name)
                              ├─ its volume `data` (10 GB, encrypted) — the engine's home, kept for good
                              └─ one machine `engine`: the release's image by digest, the engine's settings (the same as
                                 the installer gives on a machine), restart always
release chosen ──────────────► platform: Fly swaps the machine's image (a sleeping machine is started on it)
                              ├─ the engine reports it runs it ──► switched
                              └─ not within 6 minutes ─────────► the image before is put back: rolled back
                              each step in the same switch record a machine's updater writes
placing again ───────────────► the same app, volume and machine brought up to date, started, a fresh idle day
any work ────────────────────► awake at once, and for a whole day after the last work (a person connecting or asking,
                              the engine busy)
idle (no person, no work) ───► platform: 24 h → suspend (CPU and memory no longer billed; wakes warm in ~2 s)
                                         7 days with nobody here → stop (a cold start)
a person's message ──────────► platform: the message waits; the machine is started; delivered when the engine is back
sacli engine stop --fly ─────► the machine removed; the app and its volume (the data) kept for a return
```

- **Why the platform watches idleness:** the engine only connects out, so Fly's own auto-stop (which watches traffic
  through its proxy) never sees it. A machine is never suspended in the middle of a switch.
- **Why Fly's registry:** Fly machines cannot sign in to another registry. Every release is copied there by the engine
  workflow (`scripts/registry-to-fly.sh`, the same digest, only the layers Fly lacks). Fly may drop an image no machine
  has used for a while: a switch to such a release is refused saying to run **Actions → engine → Run workflow** with `copy_to_fly` set to its tag.
- **The Fly tokens:** the platform's `FLY_API_TOKEN` (an organisation token: apps, volumes, machines) is a Worker secret;
  the workflow's `FLY_REGISTRY_TOKEN` (a deploy token of the app `superatom-engine`, which only holds the images) is a
  secret of the GitHub environment `registry`. Neither is anywhere else.
- **One place at a time:** placing on Fly is refused while the project's engine is connected from a machine.
- Logs: `flyctl logs -a superatom-<project name>` (operators with Fly access).

## When something fails

Every script ends a failure with `✗ what failed` and `→ what to do`; the run's summary points here. Nothing half-published
is ever visible to a box: blobs are written first and the manifests that name them last.

| What you see | Why | Fix |
|---|---|---|
| `check` fails at a step | the change breaks a test or typecheck | read the step's last 30 lines in the log; fix; push again |
| the engine stops connecting; its log: `fenced`, the hub's reason "does not say which engine it is" (close 4006) | the engine is older than 2026-10-18: the platform now asks every engine which engine it is ("many engines, one selected") and turns away one that does not say | switch the project to a release from 2026-10-18 or later (`sacli engine switch`), then restart the engine — it does not retry after a 4006. ORDER for this change: release the engine and switch every live project to it BEFORE deploying the control plane |
| the engine connects but answers nothing; its log: `standby — the project uses engine …` | another engine is the project's selected one (`sacli engine list`); the platform never switches by itself | `sacli engine select <this engine's id>` (its log names it), or stop the extra engine |
| `ERR_PNPM_OUTDATED_LOCKFILE` | a package.json changed without its lockfile | `pnpm install` in that folder, commit the lockfile — and check no version moved (`git diff` the lockfile) |
| `<tool>: not found` in `check` | a script uses a tool its package does not declare (it worked on a laptop that has it globally) | declare it in that package's devDependencies at the version the lockfile already holds |
| `connectors dist is committed` fails | the built connectors differ from the committed ones | `pnpm -C connectors build`, commit `connectors/dist` (`git add -f`); the build is sealed to its folder, so Mac and Linux build the same bytes |
| build fails at `apt-get update` | snapshot.debian.org is unreachable (rare; retried 5×) | re-run; the layer is cached afterwards, so this only happens when the system layer rebuilds |
| build is slow (~4 min) | the dependency layer rebuilt: a lockfile changed, or GitHub's cache expired | expected; the next build is fast again |
| `the R2 key cannot reach bucket …` | the key was revoked, mistyped or lacks the bucket | new R2 token (Object Read & Write, superatom-registry only); `gh secret set R2_ACCESS_KEY_ID --env registry --repo ashishsuperatom/ica` and the same for `R2_SECRET_ACCESS_KEY`; re-run |
| `the R2 key is not set` | the environment's secrets are missing | as above |
| `uploading … failed after retries` | a network blip outlasted the retries | re-run failed jobs; what is uploaded is kept |
| `registry.superatom.ai/v2/ answers <code>` / does not serve | the custom domain is off or misconfigured | Cloudflare → R2 → superatom-registry → Settings → Custom domains: `registry.superatom.ai` enabled, SSL active |
| `serves a different manifest` | a cache in front of the domain is stale | purge the cache for registry.superatom.ai; re-run |
| `the image says it is build X, not Y` | two releases ran at once and a name moved | re-run this one (runs on dev are queued, not concurrent) |
| GitHub Actions is down, or a release cannot wait | — | the fallback below |
| a box cannot pull | its network does not allow `registry.superatom.ai` | the site must allow `*.superatom.ai`; test with `curl https://registry.superatom.ai/v2/` on the box |
| Engine version page: **refused** | the box could not pull the image | the reason is on the page; check the box reaches registry.superatom.ai (`curl https://registry.superatom.ai/v2/`), then choose again |
| Engine version page: **rolled back** at *health* | the new engine did not reach the platform within 90 s | its last log lines are on the page; the previous engine runs; fix, release, choose the new one |
| Engine version page: **rolled back** at *start* | Docker could not create or start the new container | the reason is on the page (often disk space: `df -h`, `docker image prune`) |
| chosen ≠ running for minutes, no switching | the updater is not running on the box | `docker ps` shows `superatom-<project name>-updater`? If not, running the installer on the box again makes it again; its log: `docker logs superatom-<project name>-updater` |
| "the engine is not connected; it switches when it comes back" | the box is off or offline | nothing to do: the choice is given in the engine's next welcome |
| "there is no release …" / "does not serve" when choosing | the name is not in the registry, or the domain cannot serve it | pick from the list; check registry.superatom.ai |
| `[datasource-manager] SA_MANAGER_KEY is not set` | the manager was started outside `start.sh` / `sacli engine start` | start the engine the usual way (the key is made at start and given to the engine and the manager) |
| `[ica] agents run as this engine's own user` | no agent user (a laptop, or an image without `sa-agent`) | expected on a laptop; on a server, use the released image |
| `[ica] THE AGENT RUNNER HOLDS AN ENGINE KEY` | the runner was given a key it must not have | a bug: report it with the log; agents are not kept apart until fixed |
| `[ica] agent runner stopped … made again on their next use` | the runner (all agents) crashed | it restarts on the next question; repeated: `docker logs` the engine for the runner's error |
| agents answer "not logged in" after a switch | the runner fetches its model credentials with the model-only key — the platform must accept it (`/verify-model`, deployed with the platform) | deploy the platform first, then switch engines |
| checking the image keeps agents apart | — | `docker run --rm --entrypoint bash <image> -c 'cd /app/apps/engine && pnpm exec tsx test/isolation.image.mts'` (every line ✓) |
| a connection reads **failed — its process keeps stopping** | its connector crashed five times in five minutes; the manager left it stopped | `sacli workloads show connection/<name>` (its error); fix the source or its settings, then `sacli workloads act connection/<name> restart` |
| a connection reads **degraded — its source is unavailable, paused until …** | five failures in a row to reach it; the manager refuses at once until then (circuit breaker) | the source is down or unreachable: fix it; it is tried again on its own at that time (or `… act … test`) |
| a connection reads **newer version** | its connector has a newer build than the one it is pinned to | `sacli workloads act connection/<name> update` (and `rollback` to go back) — needs project.connectors |
| the box runs out of disk | old images pile up | `docker image prune` keeps what containers use; the updater will keep the last three |

## Releasing from another machine

`scripts/release-engine-local.sh` does the same steps with the same scripts — every check, a build on a **Linux x86_64**
Docker host (never the Mac), `registry-push.sh`, the pull-back test:

```
DOCKER_HOST=ssh://<linux box> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… scripts/release-engine-local.sh
```

The commit must already be on GitHub's `dev`, so every release can be found. The R2 key is typed in for that run.

Where to build, in order: **the forge** (the normal way, above) → **GitHub's engine workflow, run by hand** (almost every failure there is a re-run or a code fix) → **any other Linux x86_64 host**
(the demo box, or a temporary VM: the same speed and bytes as GitHub) → **the Mac, last resort**: `ALLOW_EMULATED_BUILD=1`
with Docker Desktop running (Rosetta on in its settings). The Mac's chip is ARM, so the x86_64 image is built under
emulation: it works, but slowly (10–30 min — native modules compile emulated), it can crash, and it is the build least
likely to match GitHub's bytes; the script refuses it without the flag and warns with it.

## Timings (measured 2026-10-10)

| | |
|---|---|
| checks on GitHub | ~2 min (27 s install, 90 s checks) |
| first build, empty cache | 3 min 10 s; upload of everything, 832 MB: 73 s |
| a code-only release on GitHub, end to end | 4 min 31 s: checks 2 min 12 s, build 40 s (cached), upload 39 s (2 new files, under 1 MB; 18 already there), pull-back test 38 s |
| first pull on a box | 47 s (the whole image) |

## Windows servers (planned, not tested)

Some clients give us a Windows Server. In order of preference:

1. **The same Linux image, under WSL2.** Windows Server 2022/2025 runs a Linux system in WSL2; Docker Engine runs inside it,
   and so does our image — the same digest, nothing rebuilt, nothing Windows-specific to maintain. The installer will check
   WSL2 is available (it needs virtualisation allowed on the machine) and install Docker Engine inside it.
2. **Only if a client forbids WSL2 / Hyper-V: a native Windows image**, built by a separate job on GitHub's Windows runners
   (`windows-2022`). That is a second pipeline: a Windows base image, the native modules (better-sqlite3, node-pty)
   compiled with Visual Studio's build tools, the Windows builds of Claude Code and opencode, Windows paths in the start
   script — and it needs its own test before any client runs it.

## Built and planned

Built: the layered, pinned image; the workflow; the registry as R2 files at `registry.superatom.ai`; the upload with its
read-back; the pull-back test; the fallback script; **the release chosen per project** (admin console Engine release,
`sacli engine switch`, checked against the registry, pushed and given in every welcome, what runs reported back); **the
updater** beside each engine; `sacli engine start` from the registry by digest; **the installer**, with Docker from our
own mirror (`get.superatom.site/docker`); **Fly**: every release
copied to Fly's registry, a project placed, switched, rolled back, suspended and woken by the platform.

Planned, in order: the platform holding questions during the ~minute of a switch (today a question asked then waits for
the engine's reconnection or fails plainly) → the offline path (the image as a file, `docker load`).
