// PM2 for the agent-proxy on the EC2 box.
//
//   pm2 start  agent-proxy/ecosystem.config.cjs
//   pm2 save                                       # survive a reboot (with pm2 startup, once)
//   pm2 logs   agent-proxy
//
// Secrets are NOT here. They live in agent-proxy/.env on the box (gitignored, mode 600) and are read
// below — a config file that carries keys is a config file that eventually reaches a repository.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

// A tiny .env reader rather than a dependency: this file must work on a bare box with nothing installed
// beyond node, which is also why the proxy itself uses only built-ins.
function envFile(path) {
  const out = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env — the proxy still runs, just with no keys and no verification */ }
  return out
}

module.exports = {
  apps: [{
    name: 'agent-proxy',
    script: join(__dirname, 'proxy.mjs'),
    cwd: __dirname,
    // FORK, not cluster. Setting `instances` makes pm2 choose cluster mode, where the master owns the
    // listening socket and hands connections down — which breaks both the privileged-port capability (granted
    // to the binary, not inherited through the cluster master) and the CONNECT upgrade path. It buys nothing
    // here either: relaying idle sockets is not CPU-bound, so one process is the right number.
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 20,
    // A proxy that dies takes every agent on every box with it, so restart fast and keep the log.
    restart_delay: 1000,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', ...envFile(join(__dirname, '.env')) },
    out_file: join(__dirname, 'logs', 'proxy.out.log'),
    error_file: join(__dirname, 'logs', 'proxy.err.log'),
    merge_logs: true,
    time: true,
  }],
}
