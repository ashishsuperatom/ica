# Superatom VM — Fly Machine Docker image
#
# One image → one Fly App. Each project gets its own Machine (VM instance)
# with its own volume. The code-engine connects OUT to the Cloudflare Worker
# hub — no inbound ports exposed.
#
# Build:  docker build -t superatom-vm .
# Deploy: fly deploy (or use Fly Machines API from the Worker)

# Debian (glibc), NOT alpine: the codex CLI ships glibc-only linux binaries (no musl build),
# so it will not run on alpine. opencode has musl+glibc builds; on debian it uses glibc. Both fine here.
FROM node:22-slim

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
# with that flag — so set this so the analyst/connector/modeller can run as the container's root user.
ENV IS_SANDBOX=1
RUN printf 'onlyBuiltDependencies[]=@anthropic-ai/claude-code\n' >> /root/.npmrc \
    && pnpm add -g @anthropic-ai/claude-code tsx \
    && claude --version \
    && tsx --version
# The harness spawns `claude` from PATH (override with CLAUDE_BIN).
# `tsx` is global so agent workspaces can run their .mjs/.ts with a bare `tsx <file>` (see CONTEXT.md).

WORKDIR /app

# ── Copy monorepo (pnpm workspace with workspace packages) ──────────────────
COPY vm/package.json vm/pnpm-workspace.yaml vm/.npmrc vm/pnpm-lock.yaml ./
COPY vm/packages/ ./packages/
COPY vm/apps/ ./apps/

# Install all dependencies (compiles native addons for this platform). The build
# allow-list lives in vm/package.json (pnpm.onlyBuiltDependencies) + vm/.npmrc; pnpm 9
# honors it and compiles better-sqlite3/node-pty/esbuild from source (build tools above).
RUN pnpm install --frozen-lockfile

# ── Bake the embedding model into the image ─────────────────────────────────
# bge-small-en-v1.5 (~130MB, via fastembed) drives the reflex's semantic reuse. Baked here so the engine NEVER
# downloads it at runtime — instant, immutable, and present even on a source-only fast-roll. sqlite-vec + the
# onnxruntime-node binary already installed above (onnxruntime-node is allow-listed for its postinstall).
ENV FASTEMBED_CACHE_DIR=/opt/fastembed
RUN cd /app/apps/engine \
    && node --input-type=module -e "const {FlagEmbedding,EmbeddingModel}=await import('fastembed'); const m=await FlagEmbedding.init({model:EmbeddingModel.BGESmallENV15,cacheDir:'/opt/fastembed'}); for await (const _ of m.passageEmbed(['warm'])){}; console.log('embedding model baked')"

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
# Everything stateful lives here so it survives machine restarts: per project, ONE state home under
# state/<project>/ (the workspace incl. programs + the DBs project.sqlite/grounding.sqlite/answers.sqlite),
# plus the datasource registry + connector-written bridges (datasources/). A fresh machine starts with these
# empty — sources are added at runtime via the connector agent. Paths are set by fly.ts (ENGINE_STATE_DIR /
# DATASOURCE_DATA_DIR / DATASOURCES_DIR).
RUN mkdir -p /app/data/state /app/data/datasources
VOLUME ["/app/data"]

# ── Build stamp ───────────────────────────────────────────────────────────────
# Unique id for THIS image. The prompt-override layer (apps/engine/prompts.ts) honors a volume override only
# when its stamp matches this id — so a freshly built image's baked prompts always win over a stale override.
# Placed last (after all COPYs) so it regenerates whenever anything above changed, without busting caches.
RUN head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > /app/BUILD_ID

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
COPY vm/docker/start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
