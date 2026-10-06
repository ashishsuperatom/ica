// THE COMPOSITION GRAPH, as a page ("The composition graph in columns", docs/platform-architecture.md): a directed graph
// walked left to right — domains → intermediate concepts → atomic concepts. Nothing selected, a column holds every thing of
// its kind; selecting one changes the columns to its right to what it composes (an intermediate column with nothing in it
// is not shown). Beside the columns, what is selected: all of it, and its editor. Everything is done here — attach,
// detach, order, make, edit (or suggest, when it is someone else's). How the graph moved over time is its own view.
// Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Columns, ColumnsSearch, Dialog, markdownToHtml, Form, Field, Notice, Receipt, Code, Empty, Icon, notify, type ColumnItem, type ColumnSpec } from '@superatom/ui'
import { useProjectHub } from './hub'
import { cached, keep } from './cache'

type Body = Record<string, any>
interface Node { name: string; title: string; line: string; scope: string; owner: string | null; hash: string; concepts: string[]; body: Body; composed?: boolean; form?: string; agents?: { name: string; title: string }[] }
interface Version { id: number; name: string; message: string; upto: number; at: number; by: string; asOf: number; changes: number }
interface Graph { domains: Node[]; intermediate: Node[]; atomic: Node[]; version?: Version }
/** Each version's parent (the version it grew from), and the version now grew from. */
interface Tree { parents: Record<string, string | null>; now: string | null }
type Focus = { kind: 'domain' | 'intermediate' | 'atomic'; name: string } | null

/** A concept's content as Markdown — a list or worked examples written before concepts were Markdown read as their Markdown. */
const toText = (b: Body): string => b.form === 'text' ? String(b.text ?? '')
  : b.form === 'worked' ? (b.items ?? []).map((e: any) => `## ${e.question}\n${(e.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n')
  : b.form === 'numbered' ? (b.items ?? []).map((l: string, i: number) => `${i + 1}. ${l}`).join('\n')
  : (b.items ?? []).map((l: string) => `- ${l}`).join('\n')
/** How an intermediate concept is composed: its title, its line, then each atomic concept beneath it — the sum of its parts. */
const composedText = (title: string, line: string, parts: Node[]) =>
  [`# ${title}${line.trim() ? `\n${line.trim()}` : ''}`, ...parts.map((p) => `## ${p.body.title ?? p.title}\n${toText(p.body).trim()}`)].join('\n\n')

export function CompositionGraph({ projectId, token }: { projectId: string; token: string | null }) {
  const hub = useProjectHub(projectId, token)
  // Shown at once from this browser's copy (cache.ts) when it was read before; the engine's answer replaces it.
  const who = (() => { try { return String(JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? '') } catch { return '' } })()
  // A named version being looked at (read-only), or null: the graph as it is now.
  const [viewing, setViewing] = useState<string | null>(null)
  const [versions, setVersions] = useState<{ versions: Version[]; tree: Tree; since: { id: number; name: string; kind: string; by: string; reason: string | null; removed: boolean }[] } | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const cacheKey = `${who}|graph|${projectId}${viewing ? `|v:${viewing}` : ''}`
  const [graph, setGraph] = useState<Graph | null>(() => { try { const c = cached(cacheKey); return c ? JSON.parse(c) as Graph : null } catch { return null } })
  const [err, setErr] = useState('')
  const [dom, setDom] = useState<string | null>(null)
  const [mid, setMid] = useState<string | null>(null)
  const [atom, setAtom] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus>(null)
  const [making, setMaking] = useState<null | { kind: 'intermediate' | 'atomic'; into: string | null }>(null)
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    try { const r = await hub.request('compositionColumns', viewing ? { version: viewing } : {}); if (r.error) setErr(r.error); else if (r.exists === false) setErr('This project has no composition graph yet.'); else { setErr(''); setGraph(r); keep(cacheKey, JSON.stringify(r)) } }
    catch (e: any) { setErr(e?.message ?? String(e)) }
  }, [hub.request, cacheKey, viewing])   // eslint-disable-line react-hooks/exhaustive-deps -- hub is a new object each render; its request is stable
  const loadVersions = useCallback(async () => {
    const r = await hub.call({ t: 'graph:versions' }).catch(() => null)
    if (r?.t === 'graph:reply') setVersions({ versions: r.versions ?? [], tree: r.tree ?? { parents: {}, now: null }, since: r.since ?? [] })
  }, [hub.call])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hub.status === 'live') { void load(); void loadVersions() } }, [hub.status, load, loadVersions])
  const [naming, setNaming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  /** Look at a version (null: now): the graph as it read then, read-only. */
  const view = (name: string | null) => { setViewing(name); setDom(null); setMid(null); setAtom(null); setFocus(null); setGraph(null) }

  const by = useMemo(() => new Map([...(graph?.domains ?? []), ...(graph?.intermediate ?? []), ...(graph?.atomic ?? [])].map((n) => [n.name, n])), [graph])
  if (err) return <Notice state="critical">{err}</Notice>
  // Until the graph is read, the page is already its shape: the search, three columns of loading rows, the detail's place.
  if (!graph) return (
    <div className="sa-graphpage">
      <ColumnsSearch value="" onChange={() => {}} placeholder="Search domains and concepts — titles and what they say" />
      <Columns keep="composition-graph" columns={[['domains', 'Domains', 'lucide:bot'], ['intermediate', 'Intermediate concepts', 'lucide:layers'], ['atomic', 'Atomic concepts', 'lucide:atom']].map(([key, title, icon]) => ({ key, title, icon, items: [], onSelect: () => {}, loading: true }))}
        detail={<div className="sa-graphpage__hint"><Icon icon="lucide:loader" /><p>{hub.status === 'live' ? 'Reading the graph…' : hub.status === 'connecting' ? 'Connecting to the project…' : 'The project is not connected. Retrying.'}</p></div>} />
    </div>
  )

  const d = graph.domains.find((x) => x.name === dom) ?? null
  const m = graph.intermediate.find((x) => x.name === mid) ?? null
  const isMid = (n: string) => by.get(n)?.composed === true
  // Every column holds every thing of its kind; what the selection on the left holds comes first, above a separator,
  // the rest below it — attached from there. A search narrows every column.
  const needle = q.trim().toLowerCase()
  const hit = (n: Node) => !needle || `${n.title} ${n.name} ${n.line} ${toText(n.body)} ${n.body.description ?? ''}`.toLowerCase().includes(needle)
  const reach = (x: Node) => [...new Set([...x.concepts.filter((n) => !isMid(n)), ...x.concepts.filter(isMid).flatMap((n) => by.get(n)?.concepts ?? [])])]
  // Where an atomic concept is attached: the selected intermediate concept, else the selected domain itself.
  const atomTarget = m ?? d
  const item = (n: Node): ColumnItem => ({ key: n.name, title: n.title || n.name, line: n.line || (n.concepts.length ? `${n.concepts.length} concept${n.concepts.length === 1 ? '' : 's'}` : undefined) })

  const change = async (t: 'graph:join' | 'graph:leave', into: string, concept: string, at?: number) => {
    const r = await hub.call({ t, into, concept, ...(at !== undefined ? { at } : {}), reason: 'in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { notify(r?.reason ?? 'The graph did not change', 'refused'); return false }
    await load(); void loadVersions(); return true
  }
  /** Detach an atomic concept from the selection: directly from it, or say which intermediate concept holds it. */
  const detachAtom = (k: string) => {
    if (!atomTarget) return
    if (atomTarget.concepts.includes(k)) { void change('graph:leave', atomTarget.name, k); return }
    const via = atomTarget.concepts.map((c) => by.get(c)).find((x) => x?.concepts.includes(k))
    notify(via ? `It is in ${via.title} — select that intermediate concept to detach it there` : 'It is not in the selection', 'refused')
  }
  const select = (kind: NonNullable<Focus>['kind'], name: string) => {
    if (kind === 'domain') { const again = dom === name; setDom(again ? null : name); setMid(null); setAtom(null); setFocus(again ? null : { kind, name }) }
    else if (kind === 'intermediate') { const again = mid === name; setMid(again ? null : name); setAtom(null); setFocus(again ? (d ? { kind: 'domain', name: d.name } : null) : { kind, name }) }
    else { setAtom(name); setFocus({ kind, name }) }
  }
  /** Go to a node from anywhere (a "part of" link): select the path to it. */
  const goTo = (name: string) => {
    const n = by.get(name); if (!n) return
    if (graph.domains.includes(n)) { setDom(name); setMid(null); setAtom(null); setFocus({ kind: 'domain', name }) }
    else if (n.composed) { setDom((cur) => (cur && by.get(cur)?.concepts.includes(name) ? cur : null)); setMid(name); setAtom(null); setFocus({ kind: 'intermediate', name }) }
    else { setMid((cur) => (cur && by.get(cur)?.concepts.includes(name) ? cur : null)); setAtom(name); setFocus({ kind: 'atomic', name }) }
  }

  const columns: ColumnSpec[] = [
    { key: 'domains', title: 'Domains', icon: 'lucide:bot', items: graph.domains.filter(hit).map(item), selected: dom, onSelect: (k) => select('domain', k), empty: needle ? 'No domain matches.' : 'No domains yet.' },
    {
      key: 'intermediate', title: 'Intermediate concepts', icon: 'lucide:layers',
      items: graph.intermediate.filter(hit).map(item), selected: mid, onSelect: (k) => select('intermediate', k),
      ...(d ? { linked: d.concepts.filter(isMid), linkedTo: d.title, onAttach: (k: string) => void change('graph:join', d.name, k), onDetach: (k: string) => void change('graph:leave', d.name, k) } : {}),
      onNew: () => setMaking({ kind: 'intermediate', into: d?.name ?? null }),
      empty: needle ? 'No intermediate concept matches.' : 'No intermediate concepts yet — make one from atomic concepts.',
    },
    {
      key: 'atomic', title: 'Atomic concepts', icon: 'lucide:atom',
      items: graph.atomic.filter(hit).map(item), selected: atom, onSelect: (k) => select('atomic', k),
      ...(atomTarget ? { linked: m ? m.concepts : reach(d!), linkedTo: atomTarget.title, onAttach: (k: string) => void change('graph:join', atomTarget.name, k), onDetach: detachAtom } : {}),
      onNew: () => setMaking({ kind: 'atomic', into: atomTarget?.name ?? null }),
      empty: needle ? 'No atomic concept matches.' : 'No atomic concepts yet.',
    },
  ]

  // Looking at a version: nothing is attached, detached or made — it is how the graph was.
  const shown = viewing ? columns.map((c) => ({ ...c, onAttach: undefined, onDetach: undefined, onNew: undefined })) : columns
  const focused = focus ? by.get(focus.name) ?? null : null
  const partOf = (name: string) => [...graph.intermediate, ...graph.domains].filter((x) => x.concepts.includes(name))
  return (
    <div className="sa-graphpage">
      <div className="sa-graphpage__top">
        <ColumnsSearch value={q} onChange={setQ} placeholder="Search domains and concepts — titles and what they say" />
        <VersionsButton versions={versions} viewing={viewing} onOpen={() => setVersionsOpen(true)} />
      </div>
      {viewing && graph.version && (
        <div className="sa-graphpage__viewing" role="status">
          <Icon icon="lucide:history" /><span><strong>Version {graph.version.name}</strong> — {graph.version.message} <span className="sa-muted">· named by {graph.version.by.replace(/^user:/, '')} on {new Date(graph.version.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · read-only</span></span>
          <span className="sa-graphpage__viewacts">
            <button className="sa-btn" onClick={() => setRestoring(true)}><Icon icon="lucide:rotate-ccw" className="sa-btn__icon" />Make this the current graph</button>
            <button className="sa-btn sa-btn--primary" onClick={() => view(null)}>Back to now</button>
          </span>
        </div>
      )}
      <Columns keep="composition-graph" columns={shown} detail={focused
        ? <Detail key={focused.name + focused.hash} hub={hub} node={focused} kind={focus!.kind} by={by} partOf={partOf(focused.name)} goTo={goTo} change={change} reload={load} intermediates={graph.intermediate} readOnly={!!viewing} />
        : <div className="sa-graphpage__hint"><Icon icon="lucide:mouse-pointer-click" /><p>Select a domain or a concept to see all of it here, change it, and walk what it composes.</p>
            <Receipt items={[['Domains', String(graph.domains.length)], ['Intermediate concepts', String(graph.intermediate.length)], ['Atomic concepts', String(graph.atomic.length)]]} /></div>} />
      {making?.kind === 'atomic' && <NewConcept hub={hub} kind="atomic" into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {making?.kind === 'intermediate' && <NewIntermediate hub={hub} atomic={graph.atomic} preset={atom ? [atom] : []} into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {versionsOpen && versions && <VersionsPanel versions={versions.versions} tree={versions.tree} since={versions.since.length} viewing={viewing}
        onView={(name) => { setVersionsOpen(false); view(name) }} onName={() => { setVersionsOpen(false); setNaming(true) }} onClose={() => setVersionsOpen(false)} />}
      {naming && <NameVersion hub={hub} since={versions?.since ?? []} last={versions?.versions[0]?.name ?? null} onClose={() => setNaming(false)} onNamed={() => { setNaming(false); void loadVersions() }} />}
      {restoring && viewing && (
        <Dialog title={`Make ${viewing} the current graph?`} onClose={() => setRestoring(false)}
          actions={<><button className="sa-btn" onClick={() => setRestoring(false)}>Cancel</button><button className="sa-btn sa-btn--primary" onClick={async () => {
            const r = await hub.call({ t: 'graph:restore', name: viewing }).catch((e) => ({ reason: String(e?.message ?? e) }))
            setRestoring(false)
            if (r?.t !== 'graph:reply') { notify(r?.reason ?? 'It was not restored', 'refused'); return }
            notify(r.restored?.length ? `Back to ${viewing}: ${r.restored.length} node${r.restored.length === 1 ? '' : 's'} changed` : `The graph already is ${viewing}`, 'note')
            view(null); void loadVersions()
          }}>Make it current</button></>}>
          <p>Every node that differs from {viewing} is set back to how it was — as new changes, so nothing is lost: today's graph stays in the history, and can be named first if you may want it back.</p>
        </Dialog>
      )}
    </div>
  )
}

/** Where the graph is, in one button: now (and what is not yet named) or the version being looked at. Opens the tree. */
function VersionsButton({ versions, viewing, onOpen }: { versions: { versions: Version[]; tree: Tree; since: unknown[] } | null; viewing: string | null; onOpen: () => void }) {
  const since = versions?.since.length ?? 0
  const at = versions?.tree.now ?? null
  const said = viewing ? `Looking at ${viewing}` : !versions ? 'Versions' : at ? `Now · ${since ? `${since} change${since === 1 ? '' : 's'} since ${at}` : `as ${at}`}` : `Now · no version named yet`
  return (
    <button className="sa-versions" onClick={onOpen} disabled={!versions} data-viewing={!!viewing} title="The graph's versions, as a tree">
      <Icon icon="lucide:git-branch" className="sa-versions__icon" /><span className="sa-versions__said">{said}</span><Icon icon="lucide:chevron-down" className="sa-versions__icon" />
    </button>
  )
}

/** The versions as a tree, oldest at the top: a version follows the one the graph was in when it was named; going back to
 *  an older version and naming again branches from it. Now sits under the version it grew from. */
function VersionsPanel({ versions, tree, since, viewing, onView, onName, onClose }: { versions: Version[]; tree: Tree; since: number; viewing: string | null; onView: (name: string | null) => void; onName: () => void; onClose: () => void }) {
  const byName = new Map(versions.map((v) => [v.name, v]))
  const kids = new Map<string | null, string[]>()
  const order = [...versions].sort((a, b) => a.upto - b.upto || a.id - b.id).map((v) => v.name)
  for (const n of order) { const p = tree.parents[n] ?? null; kids.set(p, [...(kids.get(p) ?? []), n]) }
  const NOW = '\u0000now'
  kids.set(tree.now, [...(kids.get(tree.now) ?? []), NOW])
  // A node's branches are drawn indented beneath it; its last child (the newest) carries the line on at the same depth.
  const rows: { name: string; depth: number }[] = []
  const walk = (name: string, depth: number) => {
    rows.push({ name, depth })
    const k = kids.get(name) ?? []
    k.slice(0, -1).forEach((b) => walk(b, depth + 1))
    if (k.length) walk(k[k.length - 1], depth)
  }
  ;(kids.get(null) ?? []).forEach((r) => walk(r, 0))
  // The lines through each row: a depth's line runs on while a later row is at that depth before any shallower one.
  const through = rows.map((_, i) => { const on: number[] = []; for (let d = 0; d < rows[i].depth; d++) { for (const r of rows.slice(i + 1)) { if (r.depth < d) break; if (r.depth === d) { on.push(d); break } } } return on })
  const ends = rows.map((r, i) => { for (const x of rows.slice(i + 1)) { if (x.depth < r.depth) return true; if (x.depth === r.depth) return false } return true })
  const rails = (i: number) => <>{through[i].map((d) => <span key={d} className="sa-vtree__rail" style={{ '--d': d } as CSSProperties} />)}{i > 0 && rows[i].depth > rows[i - 1].depth && <span className="sa-vtree__elbow" />}</>
  return (
    <Dialog title="Versions" onClose={onClose} actions={<button className="sa-btn" onClick={onClose}>Close</button>}>
      <ol className="sa-vtree">
        {rows.map(({ name, depth }) => {
          if (name === NOW) return (
            <li key="now" className="sa-vtree__row" data-now style={{ '--depth': depth } as CSSProperties} data-on={!viewing} data-end={ends[rows.findIndex((r) => r.name === NOW)]}>
              {rails(rows.findIndex((r) => r.name === NOW))}<span className="sa-vtree__dot" />
              <span className="sa-vtree__main">
                <span className="sa-vtree__name">Now</span>
                <span className="sa-vtree__meta">{since ? `${since} change${since === 1 ? '' : 's'} not yet named` : 'nothing changed since'}</span>
              </span>
              <span className="sa-vtree__acts">
                {viewing && <button className="sa-btn sa-btn--link" onClick={() => onView(null)}>Back to now</button>}
                {!viewing && since > 0 && <button className="sa-btn sa-btn--primary" onClick={onName}><Icon icon="lucide:tag" className="sa-btn__icon" />Name this version</button>}
              </span>
            </li>
          )
          const v = byName.get(name)!
          return (
            <li key={name} className="sa-vtree__row" style={{ '--depth': depth } as CSSProperties} data-on={viewing === name} data-end={ends[rows.findIndex((r) => r.name === name)]}>
              {rails(rows.findIndex((r) => r.name === name))}<span className="sa-vtree__dot" />
              <button className="sa-vtree__main" onClick={() => onView(viewing === name ? null : name)} title="Look at the graph as it was (read-only)">
                <span className="sa-vtree__name">{v.name}{v.changes > 0 && <span className="sa-vtree__count">+{v.changes}</span>}</span>
                <span className="sa-vtree__msg">{v.message}</span>
                <span className="sa-vtree__meta">{v.by.replace(/^user:/, '')} · {new Date(v.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </Dialog>
  )
}

/** Name the graph as it is now — with what changed since the last version, as a commit lists its changes. */
function NameVersion({ hub, since, last, onClose, onNamed }: { hub: ReturnType<typeof useProjectHub>; since: { id: number; name: string; kind: string; by: string; reason: string | null; removed: boolean }[]; last: string | null; onClose: () => void; onNamed: () => void }) {
  const [name, setName] = useState(''), [message, setMessage] = useState(''), [err, setErr] = useState('')
  const make = async () => {
    const r = await hub.call({ t: 'graph:version', name: name.trim(), message: message.trim() }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not named'); return }
    notify(`Named ${name.trim()}`, 'note'); onNamed()
  }
  return (
    <Dialog title="Name this version" onClose={onClose}>
      <Form onSubmit={() => void make()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!name.trim() || !message.trim()}>Name it</button></>}>
        <Field label="Name"><input id="nv-name" className="sa-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="A short name, like a release" /></Field>
        <Field label="What it is"><textarea id="nv-message" className="sa-input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What this version of the graph is, and what changed in it" /></Field>
        <div className="sa-graphpage__block">
          <h3 className="sa-label">{since.length} change{since.length === 1 ? '' : 's'} since {last ?? 'the start'}</h3>
          {since.length ? <ul className="sa-versions__changes">{since.slice(-200).reverse().map((c) => (
            <li key={c.id}><Code>{c.name}</Code> <span className="sa-muted">{c.removed ? 'removed' : c.kind} · {c.by.replace(/^user:/, '')}{c.reason ? ` · ${c.reason}` : ''}</span></li>))}</ul>
            : <p className="sa-note">Nothing changed since {last} — naming it again would name the same graph.</p>}
        </div>
      </Form>
    </Dialog>
  )
}

/** What is selected: all of it, and its editor. */
function Detail({ hub, node, kind, by, partOf, goTo, change, reload, intermediates, readOnly = false }: {
  hub: ReturnType<typeof useProjectHub>; node: Node; kind: NonNullable<Focus>['kind']; by: Map<string, Node>; partOf: Node[]; intermediates: Node[]; readOnly?: boolean
  goTo: (name: string) => void; change: (t: 'graph:join' | 'graph:leave', into: string, concept: string, at?: number) => Promise<boolean>; reload: () => Promise<void>
}) {
  const b = node.body
  const meta = <Receipt items={[['Name', <Code key="n">{node.name}</Code>], ['Owner', node.owner ?? 'nobody (imported)'], ['Seen by', node.scope === 'global' ? 'everyone' : node.scope], ['Version', <Code key="h">{node.hash.slice(0, 12)}</Code>]]} />
  const links = (title: string, list: Node[], empty: string) => (
    <div className="sa-graphpage__block"><h3 className="sa-label">{title}</h3>
      {list.length ? <div className="sa-words">{list.map((x) => <button key={x.name} className="sa-word sa-graphpage__link" onClick={() => goTo(x.name)}>{x.title}</button>)}</div> : <p className="sa-note">{empty}</p>}
    </div>
  )
  /** A composition's order, changed in place: up, down, detach. */
  const order = (owner: Node, title: string) => (
    <div className="sa-graphpage__block"><h3 className="sa-label">{title} <span className="sa-col__count">{owner.concepts.length}</span></h3>
      {owner.concepts.length ? <ol className="sa-graphpage__order">{owner.concepts.map((c, i) => {
        const n = by.get(c)
        return (
          <li key={c}>
            <button className="sa-graphpage__link" onClick={() => goTo(c)}>{n?.title ?? c}{n?.composed && <span className="sa-col__tag">intermediate</span>}</button>
            {!readOnly && <span className="sa-graphpage__acts">
              <button className="sa-icon-btn" disabled={i === 0} title="Move up" aria-label="Move up" onClick={() => void change('graph:join', owner.name, c, i - 1)}><Icon icon="lucide:arrow-up" /></button>
              <button className="sa-icon-btn" disabled={i === owner.concepts.length - 1} title="Move down" aria-label="Move down" onClick={() => void change('graph:join', owner.name, c, i + 1)}><Icon icon="lucide:arrow-down" /></button>
              <button className="sa-icon-btn" title="Detach" aria-label="Detach" onClick={() => void change('graph:leave', owner.name, c)}><Icon icon="lucide:unlink" /></button>
            </span>}
          </li>
        )
      })}</ol> : <p className="sa-note">Nothing yet — attach from the column.</p>}
    </div>
  )

  if (kind === 'domain') return (
    <div className="sa-graphpage__detail">
      <header className="sa-graphpage__head"><Icon icon="lucide:bot" /><div><h2>{node.title}</h2><p className="sa-note">A domain — what an agent knows from the start, composed in this order</p></div></header>
      {b.description && <p className="sa-graphpage__text">{b.description}</p>}
      <Receipt items={[
        ['Agents that are it', node.agents?.length ? node.agents.map((a) => a.title).join(', ') : '—'],
        ['Screens', (b.capabilities ?? []).join(', ') || '—'],
        ['Tools', (b.tools ?? []).join(', ') || 'all'],
        ['Programs and files', (b.files ?? []).length ? `${b.files.length}` : '—'],
      ]} />
      {(b.intents ?? []).length > 0 && <div className="sa-graphpage__block"><h3 className="sa-label">Phrases it serves</h3><div className="sa-words">{b.intents.map((t: string) => <span key={t} className="sa-word">{t}</span>)}</div></div>}
      {order(node, 'What it composes')}
 {!readOnly && <AttachPick label="Attach an intermediate concept" options={intermediates.filter((x) => !node.concepts.includes(x.name))} onAttach={(k) => void change('graph:join', node.name, k)} />}
      <SystemPrompt hub={hub} domain={node.name} />
      {meta}
    </div>
  )
  if (kind === 'intermediate') return <IntermediateDetail readOnly={readOnly} hub={hub} node={node} reload={reload} meta={meta} order={order(node, 'Its atomic concepts')} links={links('Part of', partOf, 'No domain composes it yet.')}
    composed={composedText(String(b.title ?? node.title), String(b.text ?? ''), node.concepts.map((c) => by.get(c)).filter((x): x is Node => !!x))} />
  return <AtomicDetail readOnly={readOnly} hub={hub} node={node} reload={reload} meta={meta} links={links('Part of', partOf, 'Nothing composes it yet — attach it to an intermediate concept.')} />
}

/** Attach one from a list (a domain's first intermediate concept, when its column is not shown). */
function AttachPick({ label, options, onAttach }: { label: string; options: Node[]; onAttach: (name: string) => void }) {
  const [pick, setPick] = useState('')
  if (!options.length) return null
  return (
    <div className="sa-row sa-row--tight">
      <select id="attach-pick" className="sa-input sa-input--compact" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={label}>
        <option value="">{label}…</option>{options.map((o) => <option key={o.name} value={o.name}>{o.title}</option>)}
      </select>
      <button className="sa-btn" disabled={!pick} onClick={() => { onAttach(pick); setPick('') }}><Icon icon="lucide:link" className="sa-btn__icon" />Attach</button>
    </div>
  )
}

/** Save a concept — or, when it is someone else's, suggest the change. */
function useSave(hub: ReturnType<typeof useProjectHub>, name: string, reload: () => Promise<void>) {
  const [err, setErr] = useState(''), [suggestable, setSuggestable] = useState(false), [saving, setSaving] = useState(false)
  const save = async (body: Body, reason: string) => {
    setSaving(true); setErr(''); setSuggestable(false)
    const r = await hub.call({ t: 'graph:concept', name, body, reason: reason || 'edited in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    setSaving(false)
    if (r?.t === 'graph:reply') { notify('Saved', 'note'); await reload(); return true }
    setErr(r?.reason ?? 'It was not saved'); setSuggestable(/suggest/.test(r?.reason ?? '')); return false
  }
  const suggest = async (body: Body, reason: string) => {
    const r = await hub.call({ t: 'graph:suggest', name, kind: 'concept', body, reason: reason || 'suggested in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t === 'graph:reply') { notify('Suggested — the owner decides', 'note'); setErr(''); setSuggestable(false); return true }
    setErr(r?.reason ?? 'It was not suggested'); return false
  }
  return { err, suggestable, saving, save, suggest }
}

function AtomicDetail({ hub, node, reload, meta, links, readOnly = false }: { readOnly?: boolean; hub: ReturnType<typeof useProjectHub>; node: Node; reload: () => Promise<void>; meta: ReactNode; links: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(String(node.body.title ?? ''))
  // One Markdown text: a concept written in another form (a list, worked examples) opens as its Markdown and is kept so.
  const [text, setText] = useState(toText(node.body))
  const [reason, setReason] = useState('')
  const s = useSave(hub, node.name, reload)
  const body = { title: title.trim(), form: 'text', text }
  return (
    <div className="sa-graphpage__detail">
      <header className="sa-graphpage__head"><Icon icon="lucide:atom" /><div><h2>{node.title}</h2><p className="sa-note">An atomic concept</p></div>
        {!editing && !readOnly && <button className="sa-btn" onClick={() => setEditing(true)}><Icon icon="lucide:pencil" className="sa-btn__icon" />Edit</button>}</header>
      {!editing ? (toText(node.body).trim() ? <div className="sa-graphpage__md sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(toText(node.body)) }} /> : <p className="sa-note">Empty.</p>) : (
        <Form onSubmit={() => void s.save(body, reason).then((ok) => ok && setEditing(false))} error={s.err}
          actions={<>{s.suggestable && <button type="button" className="sa-btn" onClick={() => void s.suggest(body, reason).then((ok) => ok && setEditing(false))}>Suggest this change</button>}
            <button type="button" className="sa-btn" onClick={() => setEditing(false)}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!title.trim() || !text.trim() || s.saving}>Save</button></>}>
          <Field label="Title"><input id="ac-title" className="sa-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for what it covers" /></Field>
          <Field label="What the agent should know" help="Markdown — composed into the agent's context as written.">
            <textarea id="ac-text" className="sa-input sa-graphpage__editor" rows={18} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write it in Markdown: paragraphs, lists, headings, examples." />
          </Field>
          <Field label="Why (kept in its history)"><input id="ac-why" className="sa-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What changed, and from what evidence" /></Field>
        </Form>
      )}
      {links}
      {meta}
    </div>
  )
}

function IntermediateDetail({ hub, node, reload, meta, order, links, composed, readOnly = false }: { readOnly?: boolean; hub: ReturnType<typeof useProjectHub>; node: Node; reload: () => Promise<void>; meta: ReactNode; order: ReactNode; links: ReactNode; composed: string }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(String(node.body.title ?? '')), [line, setLine] = useState(String(node.body.text ?? '')), [reason, setReason] = useState('')
  const s = useSave(hub, node.name, reload)
  const body = { ...node.body, title: title.trim(), ...(line.trim() ? { text: line.trim() } : { text: undefined }) }
  return (
    <div className="sa-graphpage__detail">
      <header className="sa-graphpage__head"><Icon icon="lucide:layers" /><div><h2>{node.title}</h2><p className="sa-note">An intermediate concept — a combination of atomic concepts, in this order</p></div>
        {!editing && !readOnly && <button className="sa-btn" onClick={() => setEditing(true)}><Icon icon="lucide:pencil" className="sa-btn__icon" />Edit</button>}</header>
      {!editing ? (node.body.text ? <p className="sa-graphpage__text">{node.body.text}</p> : null) : (
        <Form onSubmit={() => void s.save(body, reason).then((ok) => ok && setEditing(false))} error={s.err}
          actions={<>{s.suggestable && <button type="button" className="sa-btn" onClick={() => void s.suggest(body, reason).then((ok) => ok && setEditing(false))}>Suggest this change</button>}
            <button type="button" className="sa-btn" onClick={() => setEditing(false)}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!title.trim() || s.saving}>Save</button></>}>
          <Field label="Title"><input id="ic-title" className="sa-input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="A line of its own (composed above its atomic concepts)"><textarea id="ic-line" className="sa-input" rows={4} value={line} onChange={(e) => setLine(e.target.value)} /></Field>
          <Field label="Why (kept in its history)"><input id="ic-why" className="sa-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Form>
      )}
      {order}
      <div className="sa-graphpage__block"><h3 className="sa-label">What it composes to</h3><pre className="sa-graphpage__prompt">{composed}</pre></div>
      {links}
      {meta}
    </div>
  )
}

/** An intermediate concept is made from atomic ones: pick them (two or more), put them in order with the arrows, and
 *  see what they compose to as you go. */
function NewIntermediate({ hub, atomic, preset, into, onClose, onMade }: { hub: ReturnType<typeof useProjectHub>; atomic: Node[]; preset: string[]; into: string | null; onClose: () => void; onMade: (name: string) => void }) {
  const [title, setTitle] = useState(''), [line, setLine] = useState(''), [chosen, setChosen] = useState<string[]>(preset), [find, setFind] = useState(''), [err, setErr] = useState('')
  const name = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const byName = new Map(atomic.map((a) => [a.name, a]))
  const toggle = (n: string) => setChosen((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]))
  const move = (i: number, by: number) => setChosen((c) => { const x = [...c]; const [it] = x.splice(i, 1); x.splice(i + by, 0, it); return x })
  const list = atomic.filter((a) => !find || `${a.title} ${a.name} ${a.line}`.toLowerCase().includes(find.toLowerCase()))
  const make = async () => {
    const r = await hub.call({ t: 'graph:concept', name, body: { title: title.trim(), form: 'composed', ...(line.trim() ? { text: line.trim() } : {}), concepts: chosen }, reason: 'made in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not made'); return }
    notify(`Made ${title.trim()}`, 'note'); onMade(name)
  }
  return (
    <Dialog title="New intermediate concept" onClose={onClose}>
      <div className="sa-newmid">
        <Form onSubmit={() => void make()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!name || chosen.length < 2}>{into ? `Make and attach to ${into}` : 'Make'}</button></>}>
          <Field label="Title" help={name ? <>Named <Code>{name}</Code></> : undefined}><input id="nm-title" className="sa-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for what these concepts make together" /></Field>
          <Field label="A line of its own (optional)"><input id="nm-line" className="sa-input" value={line} onChange={(e) => setLine(e.target.value)} placeholder="One line on what it is, composed above its atomic concepts" /></Field>
          <div className="sa-newmid__pick">
            <div className="sa-newmid__side">
              <h3 className="sa-label">Atomic concepts <span className="sa-col__count">{chosen.length} chosen — at least two</span></h3>
              <div className="sa-cols__search"><Icon icon="lucide:search" /><input id="nm-find" className="sa-col__input" placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} /></div>
              <div className="sa-newmid__list">
                {list.map((a) => <label key={a.name} className="sa-newmid__opt"><input type="checkbox" checked={chosen.includes(a.name)} onChange={() => toggle(a.name)} /><span><span className="sa-col__title">{a.title}</span><span className="sa-col__line">{a.line}</span></span></label>)}
              </div>
            </div>
            <div className="sa-newmid__side">
              <h3 className="sa-label">In this order</h3>
              {chosen.length ? <ol className="sa-graphpage__order">{chosen.map((c, i) => (
                <li key={c}><span>{byName.get(c)?.title ?? c}</span><span className="sa-graphpage__acts" style={{ opacity: 1 }}>
                  <button type="button" className="sa-icon-btn" disabled={i === 0} aria-label="Move up" onClick={() => move(i, -1)}><Icon icon="lucide:arrow-up" /></button>
                  <button type="button" className="sa-icon-btn" disabled={i === chosen.length - 1} aria-label="Move down" onClick={() => move(i, 1)}><Icon icon="lucide:arrow-down" /></button>
                  <button type="button" className="sa-icon-btn" aria-label="Take out" onClick={() => toggle(c)}><Icon icon="lucide:x" /></button></span></li>))}</ol>
                : <p className="sa-note">Tick atomic concepts on the left.</p>}
              <h3 className="sa-label">What it composes to</h3>
              <pre className="sa-graphpage__prompt">{composedText(title.trim() || 'Untitled', line, chosen.map((c) => byName.get(c)).filter((x): x is Node => !!x))}</pre>
            </div>
          </div>
        </Form>
      </div>
    </Dialog>
  )
}

/** The whole system prompt a domain composes to — shown on request. */
function SystemPrompt({ hub, domain }: { hub: ReturnType<typeof useProjectHub>; domain: string }) {
  const [text, setText] = useState<string | null>(null), [open, setOpen] = useState(false)
  useEffect(() => { if (open && text === null) void hub.request('compositionCompose', { domain }).then((r) => setText(r.text ?? r.error ?? '')).catch((e) => setText(String(e?.message ?? e))) }, [open, text, hub, domain])
  return (
    <div className="sa-graphpage__block">
      <button className="sa-btn sa-btn--link" onClick={() => setOpen(!open)}><Icon icon={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} className="sa-btn__icon" />The system prompt it composes to</button>
      {open && (text === null ? <p className="sa-note">Composing…</p> : <pre className="sa-graphpage__prompt">{text}</pre>)}
    </div>
  )
}

/** Make an atomic concept (its content), attached to what is selected, if anything. */
function NewConcept({ hub, into, onClose, onMade }: { hub: ReturnType<typeof useProjectHub>; kind: 'atomic'; into: string | null; onClose: () => void; onMade: (name: string) => void }) {
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [err, setErr] = useState('')
  const name = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const make = async () => {
    const r = await hub.call({ t: 'graph:concept', name, body: { title: title.trim(), form: 'text', text }, reason: 'made in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not made'); return }
    notify(`Made ${title.trim()}`, 'note'); onMade(name)
  }
  return (
    <Dialog title="New atomic concept" onClose={onClose}>
      <Form onSubmit={() => void make()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!name || !text.trim()}>{into ? `Make and attach to ${into}` : 'Make'}</button></>}>
        <Field label="Title" help={name ? <>Named <Code>{name}</Code></> : undefined}><input id="nc-title" className="sa-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for what it covers" /></Field>
        <Field label="What the agent should know" help="Markdown — composed into the agent's context as written.">
          <textarea id="nc-text" className="sa-input sa-graphpage__editor" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write it in Markdown: paragraphs, lists, headings, examples." />
        </Field>
      </Form>
    </Dialog>
  )
}

