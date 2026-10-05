// ── Dashboards: publish a built React app to a project ───────────────────────
// You build the app yourself and upload the build DIRECTORY. The bytes go to R2, the project's DO records
// which build is current, and the worker serves it at /dashboard/<id>/ behind the same sign-in as everything
// else. Nothing is rewritten on upload — the object stays exactly what your bundler produced — so republishing
// is a new build id and a rollback is a metadata change.
// Drawn only with the semantic components (@superatom/ui); no CSS of its own.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Section, Form, Field, RecordList, Receipt, Notice, Status, Code, Empty, Icon } from '@superatom/ui'

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
    <div className="sa-stack sa-stack--4">
      <Section icon="lucide:layout-dashboard" title="Dashboards" subtitle="Publish a built React app behind the project's sign-in">
        <div className="sa-section__body">
          <Notice>
            Served at <Code>{host}/dashboard/&lt;id&gt;/</Code> behind the same sign-in as the rest of the project.
            Build with <Code>base: './'</Code> where you can: absolute asset paths are rewritten on the way out, a relative build needs no rewriting.
          </Notice>
        </div>
        <Form onSubmit={() => void create()}
          actions={<button className="sa-btn sa-btn--primary" disabled={!name.trim()}>Create dashboard</button>}>
          <Field label="Name">
            <input className="sa-input" placeholder="Dashboard name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </Form>
      </Section>
      {err && <Notice state="critical">{err}</Notice>}
      {note && <Notice state="ok">{note}</Notice>}

      {!list.length && <Empty icon="lucide:layout-dashboard">No dashboards yet. Each one you create appears here, ready for its first build.</Empty>}

      {list.map((d) => {
        const history = builds[d.id]
        return (
          <Section key={d.id} icon="lucide:app-window" title={d.name} subtitle={<Code>/dashboard/{d.id}/</Code>}
            actions={<>
              {d.build_id && <button type="button" className="sa-btn sa-btn--link" onClick={() => void showBuilds(d.id)}>{history ? 'Hide history' : `History${d.builds ? ` (${d.builds})` : ''}`}</button>}
              {d.build_id && <a className="sa-btn" href={`https://${host}/dashboard/${d.id}/`} target="_blank" rel="noreferrer"><Icon icon="lucide:external-link" className="sa-btn__icon" />Open</a>}
            </>}
            footer={deleting?.id === d.id
              ? <>
                  <span>Type <strong>{d.name}</strong> to delete this dashboard, its builds and its address:</span>
                  <input className="sa-input sa-input--sm" aria-label="Dashboard name" autoFocus value={deleting.typed} onChange={(e) => setDeleting({ id: d.id, typed: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setDeleting(null) }} />
                  <button type="button" className="sa-btn sa-btn--danger sa-btn--primary" disabled={deleting.typed.trim() !== d.name} onClick={() => void remove(d.id)}>Delete for good</button>
                  <button type="button" className="sa-btn sa-btn--link" onClick={() => setDeleting(null)}>Cancel</button>
                </>
              : <button type="button" className="sa-btn sa-btn--link" onClick={() => setDeleting({ id: d.id, typed: '' })}>Delete this dashboard…</button>}>
            {d.build_id
              ? <Receipt items={[
                  ['Live', <Status key="v" state="ok">{d.version ? `v${d.version}` : 'Published'}</Status>],
                  ['Published', `${fmtWhen(d.uploaded_at)}${d.uploaded_by ? ` · ${d.uploaded_by}` : ''}`],
                  ['Size', `${d.files} files · ${fmtBytes(d.bytes)}`],
                ]} />
              : <Empty>Nothing published yet. Drop a build below to publish v1.</Empty>}

            {history && (
              <RecordList rows={history} keyOf={(b) => b.build_id} empty="No builds recorded yet."
                columns={[
                  { key: 'n', label: 'Version', render: (b) => <span className="sa-row sa-row--tight">
                      <strong>v{b.n}</strong>
                      {b.kind === 'restore' && b.from_n ? <span className="sa-muted">restores v{b.from_n}</span> : null}
                      {b.current && <Status state="ok">live</Status>}
                      {b.pruned && <Status state="neutral">files removed</Status>}
                    </span> },
                  { key: 'at', label: 'Uploaded', render: (b) => <span className="sa-muted">{fmtWhen(b.uploaded_at)}</span> },
                  { key: 'size', label: 'Size', render: (b) => <span className="sa-muted">{b.files} files · {fmtBytes(b.bytes)}</span> },
                  { key: 'by', label: 'By', render: (b) => <span className="sa-muted">{b.uploaded_by ?? ''}</span> },
                  { key: 'build_id', label: 'Build', render: (b) => <Code>{b.build_id}</Code> },
                  { key: 'live', label: '', align: 'end', render: (b) => (!b.current && !b.pruned ? <button type="button" className="sa-btn" onClick={() => setConfirm({ id: d.id, build: b })}>Make live again</button> : null) },
                ]} />
            )}

            <div className="sa-section__body sa-stack">
              {confirm?.id === d.id && (() => {
                const live = history?.find((b) => b.current)
                const next = (history?.[0]?.n ?? 0) + 1
                const when = (b?: Build) => b ? `${fmtWhen(b.uploaded_at)}${b.uploaded_by ? ` · ${b.uploaded_by}` : ''} · ${b.files} files · ${fmtBytes(b.bytes)}` : '—'
                return (
                  <Notice state="attention" action={
                    <span className="sa-row sa-row--tight">
                      <button type="button" className="sa-btn sa-btn--primary" onClick={() => void makeCurrent(d.id, confirm.build.build_id)}>Make v{confirm.build.n}'s files live as v{next}</button>
                      <button type="button" className="sa-btn sa-btn--link" onClick={() => setConfirm(null)}>Cancel</button>
                    </span>
                  }>
                    <div className="sa-stack">
                      <span><strong>Live now:</strong> v{live?.n ?? '?'} · {when(live)}</span>
                      <span><strong>After:</strong> v{next}, the files of v{confirm.build.n} ({when(confirm.build)}). v{live?.n ?? '?'} stays in the history.</span>
                    </div>
                  </Notice>
                )
              })()}

              {/* Drop the build directory, or pick it. Both end up as the same list of path→file pairs. */}
              <button type="button" className="sa-sub-card" data-active={over === d.id || undefined}
                onDragOver={(e) => { e.preventDefault(); setOver(d.id) }}
                onDragLeave={() => setOver(null)}
                onDrop={async (e) => { e.preventDefault(); setOver(null); publish(d.id, await filesFromDrop(e.dataTransfer)) }}
                onClick={() => pickers.current[d.id]?.click()}>
                {busy === d.id
                  ? (progress?.id === d.id
                      ? <>
                          <span className="sa-sub-card__title">{progress.storing ? 'Storing…' : `Uploading… ${fmtBytes(progress.sent)} of ${fmtBytes(progress.total)} (${progress.total ? Math.round(100 * progress.sent / progress.total) : 0}%)`}</span>
                          <progress max={progress.total || 1} value={progress.storing ? progress.total || 1 : Math.min(progress.sent, progress.total || 1)} />
                        </>
                      : <span className="sa-sub-card__title">Uploading…</span>)
                  : <>
                      <span className="sa-sub-card__title">{over === d.id ? 'Release to publish this build' : 'Drop the build directory here, or choose a folder'}</span>
                      <span className="sa-sub-card__text">Each upload is a new version; the earlier ones stay in the history.</span>
                    </>}
              </button>
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
          </Section>
        )
      })}
    </div>
  )
}
