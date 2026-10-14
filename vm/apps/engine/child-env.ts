// WHAT A CHILD PROCESS IS GIVEN. Agents and programs are code the engine did not write; the engine's environment holds its
// key to the platform, the manager's key and model credentials. A child gets an allow-list — what any process needs to
// run — plus what its caller names, never `...process.env`.

const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM', 'NODE_PATH', 'NODE_OPTIONS', 'DATASOURCE_URL']

/** The environment for a child: the allow-list from this process's, and `extra` on top. */
export function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of PASS) { const v = process.env[k]; if (v !== undefined) out[k] = v }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v
  return out
}
