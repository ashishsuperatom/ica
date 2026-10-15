// THE ORGANISATION'S CONNECTORS — its registry (docs/connectors-plan.md R3; the user: "we want the project admin or
// whoever has permission to add connector — should be able to develop and deploy — if we gate it then things will be
// complex"). Anyone with project.connectors in one of its projects publishes a connector (built with the one build tool);
// it is usable at once in their project and the organisation's other projects see it. Safety is pinning: a connection
// stays on the version it was given until it is updated on purpose. An organisation admin may block a connector, or one
// version, after the fact (its connections then stop being run); "approval required" is a setting, off by default, under
// which a new version waits for an admin. Every change is in the organisation's audit. Kept in the OrgDO; each version's
// code in R2 at connector/<project>/<id>/<hash> — under the project that published it (its ledger counts it); every
// connection copies the code it runs into its own project, so a running connection never depends on the publisher's.

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }
export interface OrgConnectorVersion { connector: string; hash: string; manifest: Record<string, any>; bytes: number; status: 'ready' | 'proposed'; published_by: string; from_project: string; published_at: string; approved_by: string | null; blocked_at: string | null; blocked_by: string | null }
export interface OrgConnector { id: string; title: string; made_by: string; from_project: string; created_at: string; blocked_at: string | null; blocked_by: string | null; versions: OrgConnectorVersion[]
  /** The newest version that may be used: ready, not blocked (null: none — the connector is blocked, or nothing is approved yet). */
  current: OrgConnectorVersion | null }

export const connectorObjectKey = (project: string, id: string, hash: string) => `connector/${project}/${id}/${hash}`

export function orgConnectors(sql: Sql, record: (op: string, target: string, by: string, detail: unknown) => void) {
  const setting = (key: string) => ([...sql.exec('SELECT value FROM org_settings WHERE key = ?', key)][0] as any)?.value as string | undefined
  const approvalRequired = () => setting('connector_approval') === 'on'
  const versionsOf = (id: string): OrgConnectorVersion[] => ([...sql.exec('SELECT * FROM org_connector_versions WHERE connector = ? ORDER BY published_at DESC', id)] as any[])
    .map((v) => ({ ...v, manifest: JSON.parse(String(v.manifest)), bytes: Number(v.bytes) }))
  function list(): OrgConnector[] {
    return ([...sql.exec('SELECT * FROM org_connectors ORDER BY id')] as any[]).map((c) => {
      const versions = versionsOf(String(c.id))
      const current = c.blocked_at ? null : versions.find((v) => v.status === 'ready' && !v.blocked_at) ?? null
      return { ...c, versions, current } as OrgConnector
    })
  }
  return {
    list,
    approvalRequired,
    /** A version published from a project (its code already kept by that project in the bucket). */
    publish(o: { manifest: Record<string, any>; hash: string; bytes: number; by: string; project: string }): { ok: true; status: 'ready' | 'proposed'; already?: boolean } | { ok: false; error: string } {
      const id = String(o.manifest?.id ?? '')
      if (!/^[a-z][a-z0-9-]*$/.test(id)) return { ok: false, error: 'a connector\'s id is lower-case letters, digits and dashes' }
      if (!/^[0-9a-f]{64}$/.test(o.hash)) return { ok: false, error: 'a version is named by the hash of its build' }
      const [c] = [...sql.exec('SELECT * FROM org_connectors WHERE id = ?', id)] as any[]
      if (c?.blocked_at) return { ok: false, error: `${id} is blocked in this organisation (by ${c.blocked_by}) — an organisation admin unblocks it` }
      const [had] = [...sql.exec('SELECT status FROM org_connector_versions WHERE connector = ? AND hash = ?', id, o.hash)] as any[]
      if (had) return { ok: true, status: had.status, already: true }
      const at = new Date().toISOString(), status = approvalRequired() ? 'proposed' : 'ready'
      if (!c) sql.exec('INSERT INTO org_connectors (id, title, made_by, from_project, created_at) VALUES (?, ?, ?, ?, ?)', id, String(o.manifest.title ?? id), o.by, o.project, at)
      else sql.exec('UPDATE org_connectors SET title = ? WHERE id = ?', String(o.manifest.title ?? id), id)
      sql.exec('INSERT INTO org_connector_versions (connector, hash, manifest, bytes, status, published_by, from_project, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, o.hash, JSON.stringify(o.manifest), o.bytes, status, o.by, o.project, at)
      record('connector.publish', `${id}@${o.hash.slice(0, 12)}`, o.by, { project: o.project, status, bytes: o.bytes })
      return { ok: true, status }
    },
    /** Blocked (or unblocked): a whole connector, or one version of it. */
    block(o: { id: string; hash?: string; by: string; unblock?: boolean }): { ok: true } | { ok: false; error: string } {
      const [c] = [...sql.exec('SELECT id FROM org_connectors WHERE id = ?', o.id)] as any[]
      if (!c) return { ok: false, error: `there is no connector ${o.id} in this organisation` }
      const at = o.unblock ? null : new Date().toISOString(), by = o.unblock ? null : o.by
      if (o.hash) {
        const n = [...sql.exec('UPDATE org_connector_versions SET blocked_at = ?, blocked_by = ? WHERE connector = ? AND hash LIKE ? RETURNING hash', at, by, o.id, `${o.hash}%`)].length
        if (n !== 1) return { ok: false, error: n ? `${o.hash} names more than one version — give more of its hash` : `${o.id} has no version ${o.hash}` }
      } else sql.exec('UPDATE org_connectors SET blocked_at = ?, blocked_by = ? WHERE id = ?', at, by, o.id)
      record(o.unblock ? 'connector.unblock' : 'connector.block', o.hash ? `${o.id}@${o.hash.slice(0, 12)}` : o.id, o.by, {})
      return { ok: true }
    },
    /** A proposed version approved (when the organisation asks for approval). */
    approve(o: { id: string; hash: string; by: string }): { ok: true } | { ok: false; error: string } {
      const rows = [...sql.exec("UPDATE org_connector_versions SET status = 'ready', approved_by = ? WHERE connector = ? AND hash LIKE ? AND status = 'proposed' RETURNING hash", o.by, o.id, `${o.hash}%`)]
      if (rows.length !== 1) return { ok: false, error: rows.length ? 'that names more than one version' : `${o.id} has no version ${o.hash} waiting for approval` }
      record('connector.approve', `${o.id}@${String((rows[0] as any).hash).slice(0, 12)}`, o.by, {})
      return { ok: true }
    },
    setApproval(on: boolean, by: string) {
      sql.exec("INSERT INTO org_settings (key, value) VALUES ('connector_approval', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", on ? 'on' : 'off')
      record('connector.approval', on ? 'on' : 'off', by, {})
    },
  }
}
