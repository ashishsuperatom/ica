// PM2 ecosystem — the sa-engine (ICA) against the DEPLOYED hub (Durable Object).
//
// Topology (the only one): the UI is the deployed app (e.g. acme.superatom.site) → DO →
// code-engine over WebSocket. sa-engine connects OUT to the deployed hub as role code-engine
// using ICA_HUB / ICA_PROJECT / ICA_KEY from vm/apps/engine/.env (gitignored). It NEVER serves
// the UI. The ICA (Claude Code / pi / opencode) is just a module inside sa-engine (ica/).
// Only two things run locally: the data bridge and sa-engine.
//
//   pm2 start ecosystem.config.cjs
//   pm2 logs sa-engine          # watch the question flow
//   pm2 restart sa-engine
//   pm2 delete ecosystem.config.cjs
//
// Ports:  4000  sa-datasources (the ONE data seam: query(id,sql,params) → routes by id to a bridge;
//               the TotalGroup bridge owns the WS to the remote DB. units/agents hit :4000 only)
//         4096  opencode serve (auto-started by sa-engine when ICA_HARNESS=opencode)
// sa-engine has no inbound port — it's a WS client of the deployed DO.

const root = __dirname
const fs = require('node:fs')

// Read a project's gitignored .env into an object, so per-project secrets (ICA_KEY/HUB, source creds)
// stay OUT of this committed file and are injected into the app's env at pm2-start time.
function readEnv(path) {
  const out = {}
  try {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
    }
  } catch { /* project may not exist */ }
  return out
}

// Projects are keyed by their UNIQUE project id (UUID) on disk — names collide, ids don't, and the id is
// exactly what the engine connects to the hub with (ICA_PROJECT). This map keeps the config readable
// (name → id); the human-facing name→id index also lives in vm/projects/INDEX.md.
const IDS = {
  totalgroup: '22dd6ecd-7878-4739-bb23-bc7703737807',
  fusion5:    '1c20400d-99b6-4afb-ba71-0e458a78b1a2',
}

// fusion5 = a SECOND project (NetSuite). Same engine/agents/ICA code — a second INSTANCE, pointed at
// fusion5's project id/hub/key + its own datasource-manager. Its config comes from projects/<id>/.env.
const fusion5 = readEnv(`${root}/vm/projects/${IDS.fusion5}/.env`)

module.exports = {
  apps: [
    {
      name:        'sa-datasources',
      script:      '/opt/homebrew/bin/pnpm',
      args:        'exec tsx src/index.ts',
      cwd:         `${root}/vm/apps/datasources/manager`,   // one manager per project; sources come from its registry.json
      interpreter: 'none',
      watch:       false,
      // totalgroup: load sources from projects/totalgroup/datasources/registry.json (the uniform structure the
      // connector agent also writes into). No SOURCES env / hardcoded default anymore.
      env:         { PATH: process.env.PATH, DATASOURCE_PORT: '4000', DATASOURCE_DATA_DIR: `${root}/vm/projects/${IDS.totalgroup}/datasources` },
    },
    {
      name:        'sa-engine',
      script:      '/opt/homebrew/bin/pnpm',
      args:        'exec tsx engine.ts',
      cwd:         `${root}/vm/apps/engine`,          // the new engine; ICA lives in ica/. Config from vm/apps/engine/.env
      interpreter: 'none',
      watch:       false,
      env:         { PATH: process.env.PATH, DATASOURCES_DIR: `${root}/vm/projects/${IDS.totalgroup}/datasources` },   // where the connector writes bridges (same dir the manager reads)
    },

    // ── fusion5 (NetSuite) — second project, same engine/agents code ──────────────────────────────
    {
      name:        'sa-datasources-fusion5',
      script:      '/opt/homebrew/bin/pnpm',
      args:        'exec tsx src/index.ts',
      cwd:         `${root}/vm/apps/datasources/manager`,   // same manager code; scoped to fusion5 by its registry.json
      interpreter: 'none',
      watch:       false,
      env:         { PATH: process.env.PATH, DATASOURCE_PORT: '4010', DATASOURCE_DATA_DIR: `${root}/vm/projects/${IDS.fusion5}/datasources` },
    },
    {
      name:        'sa-engine-fusion5',
      script:      '/opt/homebrew/bin/pnpm',
      args:        'exec tsx engine.ts',
      cwd:         `${root}/vm/apps/engine`,          // SAME engine code; only the env differs (project/hub/key/source)
      interpreter: 'none',
      watch:       false,
      // ICA_PROJECT/ICA_HUB/ICA_KEY/DATASOURCE_URL from fusion5/.env win over engine/.env (loadEnvFile
      // does not override an already-set var), so this instance targets fusion5 without any engine change.
      env:         { PATH: process.env.PATH, ...fusion5, DATASOURCES_DIR: `${root}/vm/projects/${IDS.fusion5}/datasources` },
    },
  ],
}
