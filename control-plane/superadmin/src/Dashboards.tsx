// ── Dashboards: publish a built React app to a project ───────────────────────
// You build the app yourself and upload the build DIRECTORY. The bytes go to R2, the project's DO records
// which build is current, and the worker serves it at /dashboard/<id>/ behind the same sign-in as everything
// else. Nothing is rewritten on upload — the object stays exactly what your bundler produced — so republishing
// is a new build id and a rollback is a metadata change.
import React, { useCallback, useEffect, useRef, useState } from 'react'

type Dash = { id: string; name: string; build_id?: string; files?: number; bytes?: number; uploaded_by?: string; uploaded_at?: number }

const fmtBytes = (n = 0) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
const fmtWhen = (ms?: number) => ms ? new Date(ms).toLocaleString() : '—'

/** Every file under a dropped directory. A drop gives DataTransferItems, not files, so the tree is walked;
 *  the folder picker gives a flat list already carrying each file's relative path. */
async function filesFromDrop(dt: DataTransfer): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = []
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (!entry) return
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej))
      out.push({ path: prefix + entry.name, file })
      return
    }
    if (entry.isDirectory) {
      const reader = entry.createReader()
      // readEntries returns at most 100 at a time — keep calling until it comes back empty.
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`)
      }
    }
  }
  const roots = [...dt.items].map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  // A single dropped folder is the build root itself, so its own name is not part of the path.
  for (const r of roots) {
    if (roots.length === 1 && r.isDirectory) {
      const reader = r.createReader()
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, '')
      }
    } else await walk(r, '')
  }
  return out
}

export function DashboardsPanel({ api, token, projectId, host }: { api: (p: string, i?: RequestInit) => Promise<Response>; token: string | null; projectId: string; host: string }) {
  const [list, setList] = useState<Dash[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const pickers = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(() => {
    api(`/projects/${projectId}/dashboards`).then((r) => (r.ok ? r.json() : { dashboards: [] }))
      .then((d) => setList((d as { dashboards?: Dash[] }).dashboards ?? [])).catch(() => {})
  }, [api, projectId])
  useEffect(load, [load])

  const create = async () => {
    if (!name.trim()) return
    setErr('')
    const r = await api(`/projects/${projectId}/dashboards`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
    if (!r.ok) { setErr(await r.text()); return }
    setName(''); load()
  }

  const publish = async (id: string, files: { path: string; file: File }[]) => {
    if (!files.length) return
    setErr(''); setBusy(id)
    try {
      const form = new FormData()
      // The field NAME is the path inside the build — that is what the worker stores it as.
      for (const f of files) form.append(f.path, f.file, f.file.name)
      // fetch() directly, NOT the shared api(): that sets content-type: application/json, which would stop the
      // browser writing the multipart boundary and the upload would arrive unparseable.
      const r = await fetch(`/api/projects/${projectId}/dashboards/${encodeURIComponent(id)}/upload`, {
        method: 'POST', body: form, headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (!r.ok) setErr(await r.text())
      load()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(null) }
  }

  const remove = async (id: string) => {
    await api(`/projects/${projectId}/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="card">
      <strong>Dashboards</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>
        Upload a built React app. It is served at <code className="mono">{host}/dashboard/&lt;id&gt;/</code> behind the same sign-in as the rest of the project.
        Build with <code className="mono">base: './'</code> where you can — absolute asset paths are rewritten on the way out, but a relative build needs no rewriting at all.
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Dashboard name" value={name}
               onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button className="btn" onClick={create} disabled={!name.trim()}>Create</button>
      </div>
      {err && <div className="muted" style={{ color: '#b3261e', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}

      {!list.length && <div className="muted" style={{ fontSize: 12.5 }}>No dashboards yet.</div>}

      {list.map((d) => (
        <div key={d.id} style={{ border: '1px solid var(--hair, #e2e4e8)', borderRadius: 6, padding: 12, marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{d.name}</strong>
              <code className="mono" style={{ fontSize: 11.5, marginLeft: 8, opacity: .7 }}>/dashboard/{d.id}/</code>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {d.build_id && <a className="btn" href={`https://${host}/dashboard/${d.id}/`} target="_blank" rel="noreferrer">Open ↗</a>}
              <button className="btn" onClick={() => remove(d.id)}>Delete</button>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
            {d.build_id
              ? <>Published {fmtWhen(d.uploaded_at)} · {d.files} files · {fmtBytes(d.bytes)}{d.uploaded_by ? ` · ${d.uploaded_by}` : ''}</>
              : <>Nothing published yet.</>}
          </div>

          {/* Drop the build directory, or pick it. Both end up as the same list of path→file pairs. */}
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(d.id) }}
            onDragLeave={() => setOver(null)}
            onDrop={async (e) => { e.preventDefault(); setOver(null); publish(d.id, await filesFromDrop(e.dataTransfer)) }}
            onClick={() => pickers.current[d.id]?.click()}
            style={{
              border: `1.5px dashed ${over === d.id ? '#15385c' : 'var(--hair, #cbd0d6)'}`,
              background: over === d.id ? 'rgba(21,56,92,.04)' : 'transparent',
              borderRadius: 6, padding: '18px 12px', textAlign: 'center', cursor: 'pointer',
              fontSize: 12.5, color: 'var(--muted, #6c7075)',
            }}>
            {busy === d.id ? 'Uploading…' : <>Drop the build directory here, or <u>choose a folder</u></>}
          </div>
          <input
            ref={(el) => { pickers.current[d.id] = el }}
            type="file" multiple hidden
            // @ts-expect-error — directory picking is not in the DOM types
            webkitdirectory="" directory=""
            onChange={(e) => {
              const fs = [...(e.target.files ?? [])]
              // webkitRelativePath is `dist/assets/x.js`; the chosen folder is the build root, so drop its name.
              const files = fs.map((f) => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, file: f }))
              publish(d.id, files); e.target.value = ''
            }} />
        </div>
      ))}
    </div>
  )
}
