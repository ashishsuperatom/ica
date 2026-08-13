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
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl \
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

# `fly ssh console` opens an interactive shell that does NOT inherit the image's ENV PATH, so the agent
# CLIs (needed for manual `... auth login`) aren't found. Put them on PATH for every SSH session:
#   - global pnpm bins  → claude, tsx           (/usr/local/share/pnpm)
#   - workspace bins    → opencode, codex       (the engine's + hoisted node_modules/.bin)
# HOME → the volume so an SSH `claude/opencode/codex auth login` writes to the SAME place the engine reads
# (and survives restarts). PATH so the agent CLIs are found. Both for every `fly ssh console` session.
RUN printf 'export HOME=/app/data/agent-home\nmkdir -p "$HOME" 2>/dev/null\nexport PATH="/usr/local/share/pnpm:/app/apps/engine/node_modules/.bin:/app/node_modules/.bin:$PATH"\n' >> /root/.bashrc

# ── Volume mount point (persisted across stop/start) ────────────────────────
# Everything stateful lives here so it survives machine restarts: the engine's answers + consolidation
# watermark (engine-data/<project>), the agent workspaces incl. programs + the semantic model project.sqlite
# (workspace/<project>), and the datasource registry + connector-written bridges (datasources/). A fresh
# machine starts with these empty — sources are added at runtime via the connector agent. Paths are set by
# fly.ts (ENGINE_DATA_DIR / ENGINE_WORKSPACE_DIR / DATASOURCE_DATA_DIR / DATASOURCES_DIR).
RUN mkdir -p /app/data/engine-data /app/data/workspace /app/data/datasources
VOLUME ["/app/data"]

# ── Startup ─────────────────────────────────────────────────────────────────
COPY vm/docker/start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
