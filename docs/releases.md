# Releases — what we ship, and how others install and upgrade it

One system for everything we hand out — the products `sacli`, `sdk`, `engine` (its installer) and `docker` — with the
engine's images beside them. Decided
2026-10-13 with the user: versions with a latest, one place to publish from, one to install and upgrade from — all on
`*.superatom.site` (and `*.superatom.ai` for the engine registry) and our R2 bucket only. The public website keeps
`superatom.site` itself; releases have their own host.

## The hosts

| Host | Serves | Code |
|---|---|---|
| `get.superatom.site` | every product's versions, channels and installers | `control-plane/superadmin/src/releases.ts` (the Worker, read-only) |
| `registry.superatom.site` | the engine's images (`docker pull`) | the same file, `handleRegistryHost` |
| `registry.superatom.ai` | the same images — the bucket's custom domain | Cloudflare → R2 → superatom-registry → Custom domains |

Two pages on `superatom.site` explain it (same file, `installPage`, `agentMd`):

- **`superatom.site/install`** — for people: install, upgrade, versions, the key, the engine, failures, publishing; with
  each product's current versions read from the bucket. A browser opening `get.superatom.site/` is sent there.
- **`superatom.site/agent.md`** — for AI agents: how to install sacli, hold a key safely, find their way and do the
  common work. It is `cli/agent.md`, published with each sacli version and served as the latest one's, so it always
  matches the sacli people install. Edit it there; it goes live with the next sacli release.

Both registries serve the same files from one bucket; a box may use either. Nothing can write through any of them.

## The layout (bucket `superatom-registry`, Worker binding `REGISTRY`)

```
releases/<product>/<version>/<file>          each file of a version — written once, never changed
releases/<product>/<version>/manifest.json   { product, version, commit, at, files: [{ name, size, sha256 }] }
releases/<product>/channels/<channel>.json   { product, channel, version, at } — the only thing that moves
v2/…                                         the engine's images (docs/deploying-the-engine.md)
```

A version is a name with a digit in it (`0.2.0`, `dev-20261013-1a2b3c4d`); a channel is letters only (`latest`, `beta`).

## Addresses on get.superatom.site

| Path | Answer | Cached |
|---|---|---|
| `/` | the products, what `latest` names for each, each one's install line | 1 min |
| `/<product>` | its channels and versions | 1 min |
| `/<product>/install.sh` | its installer at `latest` — each product installs itself; there is no bare `/install.sh` | 1 min |
| `/<product>/<version>` | that version's manifest | for ever |
| `/<product>/<channel>` | the manifest of the version the channel names now | 1 min |
| `/<product>/<version or channel>/<file>` | the file (`x-superatom-version` says which version) | for ever / 1 min |

## Publishing

`scripts/release.sh` does it for every product:

```
scripts/release.sh <product> <version> [--channel latest] [--commit <sha>] <file>…   publish a version
scripts/release.sh <product> --move <channel> <version>                            point a channel (also a rollback)
scripts/release.sh <product> --check <version>                                     is it published?
```

The order is what makes it safe: get.superatom.site must answer first; files go up, then the manifest (until then the
version does not exist), every file is read back through get.superatom.site and its sha256 checked, and only then the
channel moves. A version already there is refused. It needs the R2 key for the bucket, which lives only in the GitHub
environment `registry` (dev branch only) — the same key the engine's images use.

## sacli

- **Released** by `.github/workflows/sacli.yml` on every push to `dev` that touches the CLI: every check, then — if
  `cli/package.json`'s version is not yet published — build, publish `sacli.mjs` and `install.sh`, make it `latest`,
  and install it from get.superatom.site as someone outside would. The release's files: `sacli.mjs`, `install.sh`,
  `agent.md`. To release: raise the version, push to dev.
- **Installed** with `curl -fsSL https://get.superatom.site/sacli/install.sh | sh` (`| sh -s -- 0.2.0` for a given
  version). Needs Node 22. Each version is kept in `~/.superatom/sacli/<version>/`, `current` points at the one in use,
  and `~/.local/bin/sacli` is a launcher that runs `current`. The sha256 is checked before anything is replaced.
- **Upgraded** with `sacli upgrade` (or `sacli upgrade <version>` to go to, or back to, any version). Background
  connections are closed so the next command runs the new version. Once a day, on a terminal, an installed sacli says
  when a newer one is out (`SACLI_NO_UPDATE_CHECK=1` turns it off).
- `sacli warehouse load` reads files with DuckDB, which is not in the download: sacli says how to add it when needed.

## The platform SDK (`sdk`)

Types and docs a project's code is written against (`scripts/build-sdk.mjs`): `@superatom/ui` and `@superatom/program`
as declarations, the design system's guide and CSS, the program contract, the guide for agents, a template agent — one
`sdk.json`. Released by the same workflow as sacli, its version named by its content (`1.<hash>`), so an unchanged SDK
publishes nothing. `sacli clone` and `sacli pull` write it into a project's `platform/`.

## Docker (`docker`)

Docker's official static binaries for x86_64 Linux, which the engine installer takes from here and nowhere else. The
version and its SHA-256 are pinned in `vm/apps/updater/install.sh`; the `docker-mirror` workflow fetches that version from
download.docker.com, checks it against the pin and publishes `docker/<version>/docker-<version>-x86_64.tgz` — on a push
that changes the pin, or by hand (Actions → docker-mirror → Run).

## The engine (`engine`)

Each engine release publishes its installer, `engine/<version>/install.sh` (`latest` = the newest), from the engine
workflow; the images themselves are in the registry (`v2/`, served at registry.superatom.ai) — docs/deploying-the-engine.md.

## A new product

Pick its name, give its files (and an `install.sh` if people install it), and call `scripts/release.sh` from its own
workflow, the way sacli.yml does. Nothing in the Worker changes.

## When something fails

| What you see | Why | Fix |
|---|---|---|
| `get.superatom.site does not serve releases` | the platform is not deployed with `src/releases.ts` | `scripts/deploy-control-plane.sh`, then run again |
| `<product> <version> is already published` | a version never changes | raise the version |
| the files are up, the channel did not move | the run stopped after publishing | `scripts/release.sh <product> --move latest <version>` |
| installer: `sha256 differs` | a download was cut short, or something in between changes files | run again; if it persists, look at what sits between that machine and Cloudflare |
| installer: `needs Node.js 22` | an older or no Node | install Node 22 (nodejs.org or a package manager) |
| `sacli upgrade`: `was not installed by the installer` | a sacli from the repository or a tarball | install it with the curl line once; from then on it upgrades itself |
