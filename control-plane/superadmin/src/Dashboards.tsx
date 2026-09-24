// ── Dashboards: publish a built React app to a project ───────────────────────
// You build the app yourself and upload the build DIRECTORY. The bytes go to R2, the project's DO records
// which build is current, and the worker serves it at /dashboard/<id>/ behind the same sign-in as everything
// else. Nothing is rewritten on upload — the object stays exactly what your bundler produced — so republishing
// is a new build id and a rollback is a metadata change.
import React, { useCallback, useEffect, useRef, useState } from 'react'

type Dash = { id: string; name: string; build_id?: string; files?: number; bytes?: number; uploaded_by?: string; uploaded_at?: number; version?: number; builds?: number }
type Build = { build_id: string; n: number; files: number; bytes: number; uploaded_by?: string; uploaded_at: number; current: boolean; kind?: string; from_n?: number; pruned?: boolean }

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

export function DashboardsPanel({ api, token, projectId }: { api: (p: string, i?: RequestInit) => Promise<Response>; token: string | null; projectId: string }) {
  const [list, setList] = useState<Dash[]>([])
  // WHERE the dashboard will be reachable — the project's own subdomain, not this console's host. Linking to
  // location.host sent people to superadmin.superatom.site/dashboard/…, which is not where it is served.
  // Falls back to <projectId>.superatom.site, which the worker resolves directly and always works.
  const [host, setHost] = useState(`${projectId}.superatom.site`)
  useEffect(() => {
    api(`/domains/by-project?projectId=${projectId}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { const s0 = (d as any)?.subdomains?.[0]; const name = typeof s0 === 'string' ? s0 : s0?.subdomain
                     if (name) setHost(`${name}.superatom.site`) })
      .catch(() => {})
  }, [api, projectId])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
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

  // Upload progress: what has left this machine, then "storing" while the worker hashes and writes. fetch()
  // cannot report bytes sent; XMLHttpRequest can, so the upload goes that way.
  const [progress, setProgress] = useState<{ id: string; sent: number; total: number; storing: boolean } | null>(null)
  const publish = async (id: string, files: { path: string; file: File }[]) => {
    if (!files.length) return
    setErr(''); setNote(''); setBusy(id)
    try {
      const form = new FormData()
      // The field NAME is the path inside the build — that is what the worker stores it as.
      for (const f of files) form.append(f.path, f.file, f.file.name)
      const total = files.reduce((a, f) => a + f.file.size, 0)
      setProgress({ id, sent: 0, total, storing: false })
      const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/projects/${projectId}/dashboards/${encodeURIComponent(id)}/upload`)
        if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
        // No content-type by hand: the browser writes the multipart boundary itself.
        xhr.upload.onprogress = (e) => setProgress({ id, sent: e.loaded, total: e.lengthComputable ? e.total : total, storing: false })
        xhr.upload.onload = () => setProgress({ id, sent: total, total, storing: true })
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
        xhr.onerror = () => reject(new Error('the upload failed before a reply'))
        xhr.send(form)
      })
      if (status < 200 || status >= 300) setErr(text)
      else {
        let out: { unchanged?: boolean; restored?: boolean; version?: number } = {}
        try { out = JSON.parse(text) } catch { /* a bare ok */ }
        setNote(out.unchanged ? `That build is already live as v${out.version} — nothing uploaded.` : out.restored ? `Same files as an earlier version — published as v${out.version} pointing at them, nothing uploaded.` : out.version ? `Published as v${out.version}.` : '')
      }
      load()
      // An open history is refreshed, not left showing the versions from before this upload.
      if (builds[id]) { setBuilds((b) => ({ ...b, [id]: undefined })); await showBuilds(id) }
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(null); setProgress(null) }
  }

  // The ledger of builds, opened per dashboard; "make current" is the rollback, one call, no re-upload.
  const [builds, setBuilds] = useState<Record<string, Build[] | undefined>>({})
  const showBuilds = async (id: string) => {
    if (builds[id]) { setBuilds((b) => ({ ...b, [id]: undefined })); return }
    const r = await api(`/projects/${projectId}/dashboards/${encodeURIComponent(id)}/builds`)
    const d = r.ok ? await r.json() as { builds?: Build[] } : { builds: [] }
    setBuilds((b) => ({ ...b, [id]: d.builds ?? [] }))
  }
  // Making an earlier build live again is shown before it is done: what is live now, what will be live after.
  const [confirm, setConfirm] = useState<{ id: string; build: Build } | null>(null)
  const makeCurrent = async (id: string, buildId: string) => {
    setConfirm(null); setErr('')
    const r = await api(`/projects/${projectId}/dashboards/${encodeURIComponent(id)}/current`, { method: 'PUT', body: JSON.stringify({ buildId }) })
    if (!r.ok) { setErr(await r.text()); return }
    setBuilds((b) => ({ ...b, [id]: undefined })); await showBuilds(id); load()
  }

  // Deleting takes the bytes and the URL with it, so it is a quiet link and then the dashboard's own name typed
  // back — a click on the wrong row cannot do it.
  const [deleting, setDeleting] = useState<{ id: string; typed: string } | null>(null)
  const remove = async (id: string) => {
    await api(`/projects/${projectId}/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setDeleting(null); load()
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
      {note && <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{note}</div>}

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

            </div>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
            {d.build_id
              ? <>{d.version ? <strong>v{d.version}</strong> : 'Published'} · {fmtWhen(d.uploaded_at)} · {d.files} files · {fmtBytes(d.bytes)}{d.uploaded_by ? ` · ${d.uploaded_by}` : ''}
                  {' · '}<a href="#" onClick={(e) => { e.preventDefault(); showBuilds(d.id) }}>{builds[d.id] ? 'hide history' : `history${d.builds ? ` (${d.builds})` : ''}`}</a></>
              : <>Nothing published yet.</>}
          </div>

          {builds[d.id] && (
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', marginBottom: 10 }}>
              <tbody>
                {builds[d.id]!.map((b) => (
                  <tr key={b.build_id} style={{ borderTop: '1px solid var(--hair, #e2e4e8)' }}>
                    <td style={{ padding: '5px 6px', fontWeight: b.current ? 600 : 400 }}>v{b.n}{b.kind === 'restore' && b.from_n ? ` · restores v${b.from_n}` : ''}{b.current ? ' · live' : ''}{b.pruned ? ' · files removed' : ''}</td>
                    <td className="muted" style={{ padding: '5px 6px' }}>{fmtWhen(b.uploaded_at)}</td>
                    <td className="muted" style={{ padding: '5px 6px' }}>{b.files} files · {fmtBytes(b.bytes)}</td>
                    <td className="muted" style={{ padding: '5px 6px' }}>{b.uploaded_by ?? ''}</td>
                    <td className="mono muted" style={{ padding: '5px 6px', fontSize: 11 }}>{b.build_id}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right' }}>{!b.current && !b.pruned && <button className="btn" onClick={() => setConfirm({ id: d.id, build: b })}>Make live again</button>}</td>
                  </tr>
                ))}
                {!builds[d.id]!.length && <tr><td className="muted" style={{ padding: '5px 6px' }}>No builds recorded yet.</td></tr>}
              </tbody>
            </table>
          )}
          {confirm?.id === d.id && (() => {
            const live = builds[d.id]?.find((b) => b.current)
            const next = (builds[d.id]?.[0]?.n ?? 0) + 1
            const when = (b?: Build) => b ? `${fmtWhen(b.uploaded_at)}${b.uploaded_by ? ` · ${b.uploaded_by}` : ''} · ${b.files} files · ${fmtBytes(b.bytes)}` : '—'
            return (
              <div style={{ border: '1px solid var(--hair, #e2e4e8)', borderRadius: 6, padding: 12, marginBottom: 10, fontSize: 12.5 }}>
                <div style={{ marginBottom: 6 }}><strong>Live now:</strong> v{live?.n ?? '?'} · {when(live)}</div>
                <div style={{ marginBottom: 10 }}><strong>After:</strong> v{next}, the files of v{confirm.build.n} ({when(confirm.build)}). v{live?.n ?? '?'} stays in the history.</div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" onClick={() => makeCurrent(d.id, confirm.build.build_id)}>Make v{confirm.build.n}'s files live as v{next}</button>
                  <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </div>
            )
          })()}

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
            {busy === d.id
              ? (progress?.id === d.id
                  ? <div>
                      <div style={{ marginBottom: 6 }}>{progress.storing ? 'Storing…' : `Uploading… ${fmtBytes(progress.sent)} of ${fmtBytes(progress.total)} (${progress.total ? Math.round(100 * progress.sent / progress.total) : 0}%)`}</div>
                      <div style={{ height: 6, borderRadius: 3, background: 'var(--hair, #e2e4e8)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${progress.total ? Math.min(100, Math.round(100 * progress.sent / progress.total)) : 0}%`, background: progress.storing ? '#15385c' : '#2f7d5b', transition: 'width .15s linear' }} />
                      </div>
                    </div>
                  : 'Uploading…')
              : <>Drop the build directory here, or <u>choose a folder</u></>}
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
          <div className="muted" style={{ fontSize: 12, marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {deleting?.id === d.id
              ? <>
                  <span>Type <strong>{d.name}</strong> to delete this dashboard, its builds and its address:</span>
                  <input className="input" style={{ maxWidth: 220 }} autoFocus value={deleting.typed} onChange={(e) => setDeleting({ id: d.id, typed: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setDeleting(null) }} />
                  <button className="btn" disabled={deleting.typed.trim() !== d.name} onClick={() => remove(d.id)} style={{ background: deleting.typed.trim() === d.name ? '#b3261e' : undefined }}>Delete for good</button>
                  <a href="#" onClick={(e) => { e.preventDefault(); setDeleting(null) }}>cancel</a>
                </>
              : <a href="#" onClick={(e) => { e.preventDefault(); setDeleting({ id: d.id, typed: '' }) }}>Delete this dashboard…</a>}
          </div>
        </div>
      ))}
    </div>
  )
}
