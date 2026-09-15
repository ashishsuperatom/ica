// PM2 ecosystem — the engines this machine runs, one pair of processes per project.
//
// Topology (the only one): the UI is the deployed app → the project's Durable Object → code-engine over WebSocket.
// Each engine connects OUT to the deployed hub as role code-engine; it never serves the UI. Beside it runs that
// project's datasource manager, the one data seam its engine and agents query.
//
// A project on this machine is a home with a .env under the state root (~/.superatom/state/<projectId>/, or
// ENGINE_STATE_DIR). Everything project-specific — its hub, key and source credentials, its name and datasource port,
// the agents it runs with — is in that .env; this file holds none of it:
//
//   ICA_PROJECT / ICA_HUB / ICA_KEY / DATASOURCE_URL     where the engine connects, and its data seam
//   PROJECT_NAME                                         names its processes: sa-engine-<name>, sa-datasources-<name>
//   DATASOURCE_PORT                                      the port its datasource manager listens on
//   anything else (ICA_COMPOSER_HARNESS, NETSUITE_*, …)  passed to both processes
//
//   pm2 start ecosystem.config.cjs                  every project with a home
//   pm2 start ecosystem.config.cjs --only sa-engine-<name>
//   pm2 logs sa-engine-<name>

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = __dirname
const STATE = process.env.ENGINE_STATE_DIR || path.join(os.homedir(), '.superatom', 'state')

// A project's .env as an object: its secrets stay out of this committed file and reach the processes at start.
function readEnv(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
    }
  } catch { /* no home */ }
  return out
}

const projects = (() => { try { return fs.readdirSync(STATE) } catch { return [] } })()
  .map((id) => ({ id, home: path.join(STATE, id), env: readEnv(path.join(STATE, id, '.env')) }))
  .filter((p) => p.env.ICA_PROJECT && p.env.DATASOURCE_PORT)

module.exports = {
  apps: projects.flatMap(({ id, home, env }) => {
    const name = env.PROJECT_NAME || id.slice(0, 8)
    return [
      {
        name:        `sa-datasources-${name}`,
        script:      '/opt/homebrew/bin/pnpm',
        args:        'exec tsx src/index.ts',
        cwd:         `${root}/vm/apps/datasources/manager`,
        interpreter: 'none',
        watch:       false,
        // The project's .env too: a bridge reads its credentials from process.env, and the manager loads the bridges.
        env:         { PATH: process.env.PATH, ...env, DATASOURCE_DATA_DIR: path.join(home, 'datasources') },
      },
      {
        name:        `sa-engine-${name}`,
        script:      '/opt/homebrew/bin/pnpm',
        args:        'exec tsx engine.ts',
        cwd:         `${root}/vm/apps/engine`,
        interpreter: 'none',
        watch:       false,
        // Stamp every line: where the time in a slow turn went is read from the log, not re-measured live.
        log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
        env:         { PATH: process.env.PATH, ...env, ENGINE_STATE_DIR: STATE, ENGINE_PROJECT_DIR: home, DATASOURCES_DIR: path.join(home, 'datasources') },
      },
    ]
  }),
}
