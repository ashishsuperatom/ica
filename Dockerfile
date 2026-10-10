# Superatom VM — Fly Machine Docker image
#
# One image → one Fly App. Each project gets its own Machine (VM instance)
# with its own volume. The code-engine connects OUT to the Cloudflare Worker
# hub — no inbound ports exposed.
#
# Build:  docker build -t superatom-vm .
# Deploy: fly deploy (or use Fly Machines API from the Worker)
#
# LAYERED SO A RELEASE IS SMALL. What changes rarely comes first — the OS, Node, pnpm, the agent CLIs, then the
# dependencies installed from the lockfile and the workspace's package.json files only — and our code comes LAST. A
# change to the code makes a new image that differs from the last by its final layers (a few MB), so a machine that
# pulls it downloads only those. The 1 GB of node_modules is rebuilt only when the lockfile or a package.json changes.
# Everything is pinned (the base by digest, pnpm, the CLIs) so the same commit builds the same image anywhere.

# Debian (glibc), NOT alpine: the codex CLI ships glibc-only linux binaries (no musl build),
# so it will not run on alpine. opencode has musl+glibc builds; on debian it uses glibc. Both fine here.
# ── The workspace's manifests, picked out ────────────────────────────────────
# Every package.json (in its own folder), the lockfile, the workspace file and .npmrc — what `pnpm install` reads, and
# nothing else, so the install layer below changes only when one of these does.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS manifests
COPY vm/ /src/
RUN mkdir -p /manifests && cd /src \
    && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests/ \; \
    && cp pnpm-lock.yaml pnpm-workspace.yaml .npmrc /manifests/

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base

# Dependencies for native modules (better-sqlite3, node-pty) + CA certs for the CLI downloads
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm via corepack (bundled with Node — no npm bootstrap). Pinned to the version in
# vm/package.json "packageManager" (pnpm@9.0.0), matching the committed lockfile
# (lockfileVersion 9.0). NOTE: pnpm 10 blocks native build scripts by default and
# ignores onlyBuiltDependencies[] in .npmrc, which breaks better-sqlite3/node-pty —
# pinning to 9 (the version that produced the lockfile) avoids that.
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# ICA agent CLIs:
#  - opencode + codex are workspace deps of vm/apps/engine → `pnpm install` below fetches each
#    platform binary and runs its postinstall (allow-listed in pnpm.onlyBuiltDependencies). The
#    engine runs via `pnpm exec`, so node_modules/.bin (opencode, codex) is on PATH. pi = no binary.
#  - Claude Code is the user's OWN agent — install it GLOBALLY (a workspace copy would shadow a real
#    system claude). Use pnpm (faster than npm; already set up via corepack). BUT pnpm gates
#    postinstall build scripts — the same gating that stopped claude's native binary from linking — so
#    we allow this package's build in the global npmrc, then `claude --version` verifies the binary
#    actually linked (fails the build loudly here if it didn't, instead of at runtime).
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
# claude-code refuses --dangerously-skip-permissions when running as root UNLESS it's told it's in a
# sandbox. A Fly Machine is a Firecracker microVM (a real sandbox), and the harness always spawns claude
# with that flag — so set this so the analyst/connector/grounding agents can run as the container's root user.
ENV IS_SANDBOX=1
RUN printf 'onlyBuiltDependencies[]=@anthropic-ai/claude-code\n' >> /root/.npmrc \
    && pnpm add -g @anthropic-ai/claude-code@2.1.295 tsx@4.23.15 \
    && claude --version \
    && tsx --version
# The harness spawns `claude` from PATH (override with CLAUDE_BIN).
# `tsx` is global so agent workspaces can run their .mjs/.ts with a bare `tsx <file>` (see CONTEXT.md).

WORKDIR /app

# ── The dependencies: from the lockfile and the package.json files ONLY ─────
# Their layer depends on nothing else, so a change to the code never reinstalls them. The manifests are picked out of
# the workspace in a stage of their own (below); BuildKit compares what that stage hands over by content, so an
# unchanged set of manifests reuses the installed layer whatever else changed.
COPY --from=manifests /manifests/ ./
# Install all dependencies (compiles native addons for this platform). The build
# allow-list lives in vm/package.json (pnpm.onlyBuiltDependencies) + vm/.npmrc; pnpm 9
# honors it and compiles better-sqlite3/node-pty/esbuild from source (build tools above).
RUN pnpm install --frozen-lockfile

# An interactive shell (`fly ssh console`, `docker exec -it`) does NOT inherit the image's ENV PATH, so the
# agent CLIs are not found when someone comes in to run a login by hand:
#   - global pnpm bins  → claude, tsx           (/usr/local/share/pnpm)
#   - workspace bins    → opencode, codex       (the engine's + hoisted node_modules/.bin)
#
# PATH ONLY. This used to export HOME here as well, which was a third place deciding it — and the one that
# quietly lost: bash reads $HOME/.bashrc, so once HOME is set properly by the image this file is not even
# read. HOME belongs to `ENV HOME` below and nowhere else.
#
# Written to BOTH homes: the image's original /root (for a shell that somehow still lands there) and the real
# one on the volume, which is where every shell arrives now.
RUN printf 'export PATH="/usr/local/share/pnpm:/app/apps/engine/node_modules/.bin:/app/node_modules/.bin:$PATH"\n' > /tmp/sa-path.sh \
    && cat /tmp/sa-path.sh >> /root/.bashrc \
    && mkdir -p /app/data/agent-home && cat /tmp/sa-path.sh >> /app/data/agent-home/.bashrc && rm /tmp/sa-path.sh

# ── Volume mount point (persisted across stop/start) ────────────────────────
# Everything stateful lives here so it survives machine restarts: per project, ONE home under
# /app/data/<project>/ — db/ (graph.sqlite: programs, memory, data sessions; datasource-index.sqlite: the datasource
# schema index; grounding.sqlite; agent-sessions.sqlite: which harness session each agent resumes), workspace/ and
# sessions/<id>/ (the agents' working directories) — plus the datasource registry + connector-written bridges
# (datasources/). A fresh machine starts with these empty — sources are added at runtime via the connector agent.
# Paths are set by fly.ts (SUPERATOM_HOME / DATASOURCE_DATA_DIR / DATASOURCES_DIR).
RUN mkdir -p /app/data/datasources
VOLUME ["/app/data"]


# ── HOME, once, for everything in this container ─────────────────────────────
# claude, codex, opencode and pi all keep their credentials under $HOME. The image's own /root is EPHEMERAL —
# it resets to the image on every recreate — so a login there works, is invisible to the agents, and is thrown
# away later.
#
# This is set HERE rather than in start.sh because an `export` in start.sh reaches only the processes it
# starts. Someone who `docker exec`s in to run `claude` gets a fresh shell with the image's HOME, and lands in
# the wrong place: the login appears to succeed and the agent still cannot authenticate. That happened, and
# cost an evening. Set in the image, it is true for every process — the engine, the agents, and any shell.
#
# Placed after the build steps: /app/data is a mount point that does not exist while building.
ENV HOME=/app/data/agent-home

# ── Startup ─────────────────────────────────────────────────────────────────
COPY --chmod=0755 vm/docker/start.sh /start.sh

# ── Our code: last, so a release is these layers only ───────────────────────
COPY vm/packages/ ./packages/
COPY vm/apps/ ./apps/
# The modules the engine shares with the platform and the clients (wire protocol, transport, parcels, explorer reads).
# The engine imports them as ../../../clients from apps/engine, which is /clients here.
COPY clients/*.ts /clients/

# ── Build stamp ───────────────────────────────────────────────────────────────
# Which build this is: the commit it was built from (the release script passes it). The prompt-override layer
# (apps/engine/prompts.ts) honors a volume override only when its stamp matches this id — so a new build's baked
# prompts always win over a stale override. A commit, not a random number, so the same commit builds the same image.
ARG BUILD_ID=dev
RUN printf '%s' "$BUILD_ID" > /app/BUILD_ID

CMD ["/start.sh"]
