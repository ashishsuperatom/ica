# Commands — the one map

Every high-level thing we do, one line each — the only list; a new workflow is added here, a changed one changed here.
Where a line needs more, the doc named after it has the detail (engine: deploying-the-engine.md; sacli and the SDK:
releases.md; a project's code: dev-mode.md). Development runs on **superatom-forge**; the laptop is a browser and a
terminal. `<p>` is a sacli profile (tg, f5, proc-demo, lab…).

## What happens by itself — and what we run by hand

| By itself | By hand |
|---|---|
| a push to dev → GitHub publishes sacli/the SDK when their version is new | every engine release (`scripts/release-engine-local.sh`) |
| a project switched to a release → its box's updater swaps the engine (rolls back if it fails) | choosing a release for a project (`engine switch`) |
| the updater moves itself onto the engine's release | every control-plane deploy (`scripts/deploy-control-plane.sh`) |
| a Fly engine sleeps a day after its last work, wakes on use | which engine a project uses (`engine select`) — never automatic |
| a deploy rolls back if a live project's DO does not start | GitHub's engine build (`gh workflow run engine.yml`) — the backup |

## Develop (on the forge)

| Command | What it does |
|---|---|
| `mosh superatom-forge` (or `ssh`) | reach the forge over Tailscale — no key, no open port |
| `cc` | Claude Code with every permission, in the repo |
| `forge on` / `forge off` (laptop) | tunnel localhost:5174/5175 to the forge's UIs, or free those ports |
| `scripts/ui-dev.sh` | both UIs with hot reload against the live platform: user app :5174, console :5175/admin/ |
| `sacli --profile <p> engine start --native` | a dev engine from this source under PM2 — a change is live on restart, no image |
| `sacli --profile <p> engine logs -f` | that engine's log |

## Check

| Command | What it does |
|---|---|
| `scripts/check-all.sh` | every typecheck and test suite, stops at the first failure — before every push |
| `pnpm -C control-plane/superadmin exec vitest run src/__tests__/<file>` | one control-plane test file |
| `node --test --import tsx test/<file>` (in `vm/apps/engine`) | one engine test file |
| `scripts/ui-review` | every page at three widths, checked for layout faults — only when asked |

## Branches

| Command | What it does |
|---|---|
| work on a branch (now `world-model`), push it | commits on the branch; nothing builds or deploys from it |
| `git switch dev && git merge --ff-only <branch> && git push origin dev` | into dev — pushing builds nothing by itself |

## Release the platform (control plane)

| Command | What it does |
|---|---|
| `scripts/deploy-control-plane.sh` | committed code only, every check, deploy, smoke test of `scripts/live-projects.txt`, rolls back by itself |
| `sacli --profile <p> engine list` | after a deploy: verify the change on each live project, not only that its DO starts |

## Release the engine (an image)

| Command | What it does |
|---|---|
| `scripts/release-engine-local.sh` | on the forge, in the background: checks, build, into registry.superatom.ai, installer, then the Fly copy |
| `gh workflow run engine.yml --ref dev` | the backup: the same release built on GitHub (run by hand only) |
| `gh workflow run engine.yml --ref dev -f copy_to_fly=<tag>` | copy a release into Fly's registry (the local release asks for it; again if Fly dropped one) |
| `~/.config/superatom/registry.env` (forge) | the R2 key the local release reads — Object Read & Write on superatom-registry only |

## Put an engine release on projects

| Command | What it does |
|---|---|
| `sacli --profile <p> engine versions` | the release chosen, the one running, the last switch step by step, every release |
| `sacli --profile <p> engine switch <tag>` | switch a project (Docker: its updater swaps within a minute; Fly: the platform swaps the image) |
| admin console → project → Engine version | the same, with buttons |
| ORDER when the platform needs the new engine | release the engine → switch every live project → then deploy the control plane |

## Which engine a project uses

| Command | What it does |
|---|---|
| `sacli --profile <p> engine list` | every engine that connected: id, machine, used or standby, connected, last seen |
| `sacli --profile <p> engine select <id>` | use that engine — never changes by itself |
| `sacli --profile <p> engine forget <id>` | drop an engine that is not connected and not used |
| admin console → project → Engines | the same, with buttons |

## Where an engine runs

| Command | What it does |
|---|---|
| `curl -fsSL https://get.superatom.site/engine/install.sh \| sh -s -- <key>` | a new Docker box: engine + its updater (the updater keeps itself current from then on) |
| `sacli --profile <p> engine start` | the same from a machine with sacli (Docker) |
| `sacli --profile <p> engine start --native` | no Docker: under PM2 from a repo checkout — switched by restarting it on new code, not by the updater |
| `sacli --profile <p> engine start --fly [--region <code>]` | on Fly, made and kept by the platform (sleeps after a day idle, wakes on use) |
| `sacli --profile <p> engine stop [--fly]` | stop it; the data stays |
| `sacli --profile <p> engine status` | where it runs here and whether the hub has it (and any standbys) |
| `docker logs sa-engine-<project>` / `sa-engine-updater-<project>` | a Docker box's engine / updater log |

## Release sacli and the SDK

| Command | What it does |
|---|---|
| raise `cli/package.json` version, push to dev | GitHub's sacli workflow publishes it to get.superatom.site (an unchanged version publishes nothing) |
| `sacli upgrade` | move to the latest sacli |
| `scripts/release.sh <product> --move <channel> <version>` | point a channel at another version (also the rollback) |

## Logins on the forge

| Command | What it does |
|---|---|
| `gh auth login` | GitHub (push, workflows) |
| `claude` → `/login` | Claude Code |
| `pnpm -C control-plane/superadmin exec wrangler login --device` | Cloudflare (deploys) — the device flow; the browser flow fails here |
| `~/.config/superatom/credentials.json` | the sacli profiles (copied from the laptop, chmod 600) |

## The forge machine (from the laptop, AWS profile brokenatom-admin)

| Command | What it does |
|---|---|
| `aws ec2 authorize-security-group-ingress --group-id sg-0f1f0713f35a687cf --protocol tcp --port 22 --cidr 0.0.0.0/0` | reopen public SSH (closed: Tailscale only) |
| stop → `aws ec2 modify-instance-attribute --instance-type …` → start | resize it |
| EC2 Serial Console | the last way in if Tailscale and SSH both fail |
