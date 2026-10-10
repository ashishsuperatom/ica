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

## The map

```
 developer / agent                GitHub (ashishsuperatom/ica)                Cloudflare R2 (superatom-registry)
 ─────────────────                ────────────────────────────                ──────────────────────────────────
 commit on graph/native
 git push origin HEAD:dev ──────► workflow "engine" (.github/workflows/engine.yml), on dev only
                                   ├─ check   pnpm install --frozen-lockfile (6 parts) → scripts/check-all.sh
                                   └─ image   (only if check passed; environment "registry" — dev only)
                                       ├─ build   Dockerfile, linux/amd64, layers cached by GitHub
                                       ├─ push    scripts/registry-push.sh ──────────► v2/superatom-engine/blobs/sha256:…
                                       │          (blobs first, manifests last,           v2/superatom-engine/manifests/<digest>
                                       │           each read back via the domain)          v2/superatom-engine/manifests/dev-<date>-<commit>
                                       └─ verify  docker pull through registry.superatom.ai,    v2/superatom-engine/manifests/dev
                                                  /app/BUILD_ID must equal the commit
                                                                                         served as files at
                                                                                         https://registry.superatom.ai
 a project's box  ◄──────────────────────────────── docker pull registry.superatom.ai/superatom-engine@sha256:<digest>
   sa-engine-<project> (one container, data on its volume)          … the digest the platform pins for that project
```

Nothing runs behind `registry.superatom.ai`: it is the bucket's custom domain serving the files `docker pull` asks for.
Slob's bucket (`frontend-packages`, `dl.superatom.ai`) is separate and untouched. Fly is not part of this path.

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
2. `git push origin HEAD:dev`.
3. Watch: `gh run watch --repo ashishsuperatom/ica $(gh run list --repo ashishsuperatom/ica --workflow engine.yml --limit 1 --json databaseId --jq '.[0].databaseId')`.
   The run's summary names the release and its digest.
4. Put it on a project — **per project, in the admin console**: the project → Operations → **Engine release** → the
   release → *Run this*. Or `SACLI_PROFILE=<project> sacli engine release dev-<date>-<commit>`. Both need project.manage.
   The page shows what is chosen, what the engine runs, and how the last switch went.
5. **Rollback**: choose the previous release the same way. Its image is still on the box: no download.

A new box: `DOCKER_HOST=ssh://<box> SACLI_PROFILE=<project> sacli engine start` pulls the release chosen for the
project (else the newest `dev`) and runs it by digest, with the updater beside it. Nothing is built on the box.

## How a switch happens on the box

```
admin console / sacli engine release ──► platform (ProjectDO): checks registry.superatom.ai serves it, keeps the choice
                                          │  pushed now (engine:release), and given again in every welcome
                                          ▼
 sa-engine-<project>   writes <project home>/engine-release/desired.json
 sa-updater-<project>  (Docker socket + the engine's volume) reads it, every 10 s:
                         1. pull the image                 — fails: "refused", nothing changed
                         2. stop the engine (60 s to finish)  — one engine at a time, never two
                         3. copy its db/ folder aside
                         4. start the new engine, same volume, settings and restart rule
                         5. wait 90 s for it to reach the platform (it writes running.json)
                         6. up: old container removed, newest 3 images kept
                            not up / crashed: its last log lines kept, db/ restored, previous engine started again,
                            and that release is not retried until a different one is chosen
                       writes result.json ──► the engine reports it ──► the admin page shows it
```

- The updater runs from the engine image (`node /app/apps/updater/updater.mjs`) — plain Node and Docker's API, nothing
  installed. It is (re)made by `sacli engine start`; it does not update itself.
- An engine stopped on purpose (`sacli engine stop`, which takes the updater away first) stays stopped.
- If the updater dies mid-switch, its next look finds the previous engine set aside and puts it back.
- Only releases from `dev-20261010-5ff39c5e` on can be switched to: an earlier one never reports that it came up, so it
  is started and then rolled back after 90 s (seen on the demo box: it reached "idle, waiting for questions" and was
  still rolled back, by design). Operator notes for the updater: `vm/apps/updater/README.md`.

## When something fails

Every script ends a failure with `✗ what failed` and `→ what to do`; the run's summary points here. Nothing half-published
is ever visible to a box: blobs are written first and the manifests that name them last.

| What you see | Why | Fix |
|---|---|---|
| `check` fails at a step | the change breaks a test or typecheck | read the step's last 30 lines in the log; fix; push again |
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
| Engine release page: **refused** | the box could not pull the image | the reason is on the page; check the box reaches registry.superatom.ai (`curl https://registry.superatom.ai/v2/`), then choose again |
| Engine release page: **rolled back** at *health* | the new engine did not reach the platform within 90 s | its last log lines are on the page; the previous engine runs; fix, release, choose the new one |
| Engine release page: **rolled back** at *start* | Docker could not create or start the new container | the reason is on the page (often disk space: `df -h`, `docker image prune`) |
| chosen ≠ running for minutes, no switching | the updater is not running on the box | `docker ps` shows `sa-updater-<project>`? If not, `sacli engine start` makes it again; its log: `docker logs sa-updater-<project>` |
| "the engine is not connected; it switches when it comes back" | the box is off or offline | nothing to do: the choice is given in the engine's next welcome |
| "there is no release …" / "does not serve" when choosing | the name is not in the registry, or the domain cannot serve it | pick from the list; check registry.superatom.ai |
| the box runs out of disk | old images pile up | `docker image prune` keeps what containers use; the updater will keep the last three |

## The fallback: releasing without GitHub Actions

`scripts/release-engine-local.sh` does the same steps with the same scripts — every check, a build on a **Linux x86_64**
Docker host (never the Mac), `registry-push.sh`, the pull-back test:

```
DOCKER_HOST=ssh://<linux box> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… scripts/release-engine-local.sh
```

The commit must already be on GitHub's `dev`, so every release can be found. The R2 key is typed in for that run.

Where to build, in order: **re-run on GitHub** (almost every failure is a re-run or a code fix) → **any Linux x86_64 host**
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
`sacli engine release`, checked against the registry, pushed and given in every welcome, what runs reported back); **the
updater** beside each engine; `sacli engine start` from the registry by digest.

Planned, in order: the platform holding questions during the ~minute of a switch (today a question asked then waits for
the engine's reconnection or fails plainly) → **the installer** for a bare restricted VM (Docker's static binaries from our
mirror, then the first pull) and the offline path (the image as a file, `docker load`).
