// THE COMPOSITION GRAPH, as a page ("The composition graph in columns", docs/platform-architecture.md): a directed graph
// walked left to right — domains → intermediate concepts → atomic concepts. Nothing selected, a column holds every thing of
// its kind; selecting one changes the columns to its right to what it composes (an intermediate column with nothing in it
// is not shown). Beside the columns, what is selected: all of it, and its editor. Everything is done here — attach,
// detach, order, make, edit (or suggest, when it is someone else's). How the graph moved over time is its own view.
// Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Columns, ColumnsSearch, Dialog, markdownToHtml, Form, Field, Notice, Receipt, Code, Empty, Icon, notify, type ColumnItem, type ColumnSpec } from '@superatom/ui'
import { useProjectHub } from './hub'
import { HistoryGraph, stepSays, stepWhen, type Step } from './GraphHistory'
import { cached, keep } from './cache'

type Body = Record<string, any>
interface Node { name: string; title: string; line: string; scope: string; owner: string | null; hash: string; concepts: string[]; body: Body; composed?: boolean; form?: string; agents?: { name: string; title: string }[] }
type Change = { id: number; name: string; kind: string; by: string; reason: string | null; removed: boolean }
interface Version { id: number; name: string; message: string; upto: number; at: number; by: string; asOf: number; changes: number }
interface Graph { domains: Node[]; intermediate: Node[]; atomic: Node[]; version?: Version }
type Focus = { kind: 'domain' | 'intermediate' | 'atomic'; name: string; edit?: boolean } | null

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
  // A step of the graph's history being looked at (read-only), or null: the graph as it is now.
  const [viewing, setViewing] = useState<Step | null>(null)
  const [versions, setVersions] = useState<{ versions: Version[]; steps: Step[]; since: Change[] } | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const cacheKey = `${who}|graph|${projectId}${viewing ? `|at:${viewing.upto}` : ''}`
  const [graph, setGraph] = useState<Graph | null>(() => { try { const c = cached(cacheKey); return c ? JSON.parse(c) as Graph : null } catch { return null } })
  const [err, setErr] = useState('')
  const [dom, setDom] = useState<string | null>(null)
  const [mid, setMid] = useState<string | null>(null)
  const [atom, setAtom] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus>(null)
  const [making, setMaking] = useState<null | { kind: 'intermediate' | 'atomic'; into: string | null }>(null)
  const [makingDomain, setMakingDomain] = useState(false)
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    try { const r = await hub.request('compositionColumns', viewing ? { upto: viewing.upto } : {}); if (r.error) setErr(r.error); else if (r.exists === false) setErr('This project has no composition graph yet.'); else { setErr(''); setGraph(r); keep(cacheKey, JSON.stringify(r)) } }
    catch (e: any) { setErr(e?.message ?? String(e)) }
  }, [hub.request, cacheKey, viewing])   // eslint-disable-line react-hooks/exhaustive-deps -- hub is a new object each render; its request is stable
  const loadVersions = useCallback(async () => {
    const r = await hub.call({ t: 'graph:versions' }).catch(() => null)
    if (r?.t === 'graph:reply') setVersions({ versions: r.versions ?? [], steps: r.steps ?? [], since: r.since ?? [] })
  }, [hub.call])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hub.status === 'live') { void load(); void loadVersions() } }, [hub.status, load, loadVersions])
  const [naming, setNaming] = useState<Step | null>(null)
  const [restoring, setRestoring] = useState<Step | null>(null)
  /** Look at a version (null: now): the graph as it read then, read-only. */
  const view = (name: Step | null) => { setViewing(name); setDom(null); setMid(null); setAtom(null); setFocus(null); setGraph(null) }

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
    { key: 'domains', title: 'Domains', icon: 'lucide:bot', items: graph.domains.filter(hit).map(item), selected: dom, onSelect: (k) => select('domain', k), onNew: () => setMakingDomain(true), empty: needle ? 'No domain matches.' : 'No domains yet.' },
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
  // A concept of the selected domain, picked in its column: the domain stays on the right, that concept open in it.
  const inDomain = !!(focus?.kind === 'atomic' && !focus.edit && d && !m && reach(d).includes(focus.name))
  const focused = inDomain ? d : focus ? by.get(focus.name) ?? null : null
  const focusKind = inDomain ? 'domain' as const : focus?.kind
  const partOf = (name: string) => [...graph.intermediate, ...graph.domains].filter((x) => x.concepts.includes(name))
  return (
    <div className="sa-graphpage">
      <div className="sa-graphpage__top">
        <ColumnsSearch value={q} onChange={setQ} placeholder="Search domains and concepts — titles and what they say" />
        <VersionsButton versions={versions} viewing={viewing} onOpen={() => setVersionsOpen(true)} />
      </div>
      {viewing && (
        <div className="sa-graphpage__viewing" role="status">
          <Icon icon="lucide:history" /><span><strong>v{viewing.n}{viewing.tags.length ? ` · ${viewing.tags.join(', ')}` : ''}</strong> — {stepSays(viewing)} <span className="sa-muted">· {stepWhen(viewing.at)} · read-only</span></span>
          <span className="sa-graphpage__viewacts">
            <button className="sa-btn" onClick={() => setNaming(viewing)}><Icon icon="lucide:tag" className="sa-btn__icon" />Name it</button>
            <button className="sa-btn" onClick={() => setRestoring(viewing)}><Icon icon="lucide:rotate-ccw" className="sa-btn__icon" />Make this the current graph</button>
            <button className="sa-btn sa-btn--primary" onClick={() => view(null)}>Back to now</button>
          </span>
        </div>
      )}
      <Columns keep="composition-graph" columns={shown} detail={focused
        ? <Detail key={focused.name + focused.hash} hub={hub} node={focused} kind={focusKind!} by={by} partOf={partOf(focused.name)} goTo={goTo} change={change} reload={load} intermediates={graph.intermediate} readOnly={!!viewing}
            openOnly={inDomain ? focus!.name : null} onEdit={(name) => { setAtom(name); setFocus({ kind: by.get(name)?.composed ? 'intermediate' : 'atomic', name, edit: true }) }} />
        : <div className="sa-graphpage__hint"><Icon icon="lucide:mouse-pointer-click" /><p>Select a domain or a concept to see all of it here, change it, and walk what it composes.</p>
            <Receipt items={[['Domains', String(graph.domains.length)], ['Intermediate concepts', String(graph.intermediate.length)], ['Atomic concepts', String(graph.atomic.length)]]} /></div>} />
      {making?.kind === 'atomic' && <NewConcept hub={hub} kind="atomic" into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {making?.kind === 'intermediate' && <NewIntermediate hub={hub} atomic={graph.atomic} preset={atom ? [atom] : []} into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {versionsOpen && versions && (
        <Dialog title="History" onClose={() => setVersionsOpen(false)} actions={<button className="sa-btn" onClick={() => setVersionsOpen(false)}>Close</button>}>
          <p className="sa-note">Every run of changes is a version, newest at the top. Going back to an older one starts a new line from it; the line left behind stays.</p>
          <div className="sa-history__scroll">
            <HistoryGraph steps={versions.steps} current={viewing?.upto ?? null}
              onPick={(st) => { setVersionsOpen(false); view(st === versions.steps[versions.steps.length - 1] ? null : st) }}
              actions={(st, isHead) => <>
                <button className="sa-btn sa-btn--link" onClick={() => { setVersionsOpen(false); setNaming(st) }}><Icon icon="lucide:tag" className="sa-btn__icon" />Name</button>
                {!isHead && <button className="sa-btn sa-btn--link" onClick={() => { setVersionsOpen(false); setRestoring(st) }}><Icon icon="lucide:rotate-ccw" className="sa-btn__icon" />Make current</button>}
              </>} />
          </div>
        </Dialog>
      )}
      {naming && <NameVersion hub={hub} step={naming} since={naming === versions?.steps[versions.steps.length - 1] ? versions?.since ?? [] : null} onClose={() => setNaming(null)} onNamed={() => { setNaming(null); void loadVersions() }} />}
      {makingDomain && <NewDomain hub={hub} onClose={() => setMakingDomain(false)} onMade={async (name) => { setMakingDomain(false); await load(); void loadVersions(); goTo(name) }} />}
      {restoring && (
        <Dialog title={`Make v${restoring.n} the current graph?`} onClose={() => setRestoring(null)}
          actions={<><button className="sa-btn" onClick={() => setRestoring(null)}>Cancel</button><button className="sa-btn sa-btn--primary" onClick={async () => {
            const st = restoring
            const r = await hub.call({ t: 'graph:restore', upto: st.upto }).catch((e) => ({ reason: String(e?.message ?? e) }))
            setRestoring(null)
            if (r?.t !== 'graph:reply') { notify(r?.reason ?? 'It was not restored', 'refused'); return }
            notify(r.restored?.length ? `Back to v${st.n}: ${r.restored.length} node${r.restored.length === 1 ? '' : 's'} changed` : `The graph already is v${st.n}`, 'note')
            view(null); void loadVersions()
          }}>Make it current</button></>}>
          <p>Every node that differs from v{restoring.n} is set back to how it was — as new changes, so nothing is lost: the graph as it is now stays in the history as its own line.</p>
        </Dialog>
      )}
    </div>
  )
}

/** Where the graph is, in one button: its latest version (and when), or the one being looked at. Opens the history. */
function VersionsButton({ versions, viewing, onOpen }: { versions: { steps: Step[] } | null; viewing: Step | null; onOpen: () => void }) {
  const head = versions?.steps[versions.steps.length - 1]
  const said = viewing ? `Looking at v${viewing.n}` : !versions ? 'History' : head ? `v${head.n} · ${stepWhen(head.at)}` : 'No changes yet'
  return (
    <button className="sa-versions" onClick={onOpen} disabled={!versions} data-viewing={!!viewing} title="The graph's history: every version, as a graph">
      <Icon icon="lucide:git-branch" className="sa-versions__icon" /><span className="sa-versions__said">{said}</span><Icon icon="lucide:chevron-down" className="sa-versions__icon" />
    </button>
  )
}

/** Name the graph as it is now — with what changed since the last version, as a commit lists its changes. */
function NameVersion({ hub, step, since, onClose, onNamed }: { hub: ReturnType<typeof useProjectHub>; step: Step; since: Change[] | null; onClose: () => void; onNamed: () => void }) {
  const [name, setName] = useState(''), [message, setMessage] = useState(''), [err, setErr] = useState('')
  const make = async () => {
    const r = await hub.call({ t: 'graph:version', name: name.trim(), message: message.trim(), upto: step.upto }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not named'); return }
    notify(`Named ${name.trim()}`, 'note'); onNamed()
  }
  return (
    <Dialog title={`Name v${step.n}`} onClose={onClose}>
      <Form onSubmit={() => void make()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!name.trim() || !message.trim()}>Name it</button></>}>
        <Field label="Name"><input id="nv-name" className="sa-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="A short name, like a release" /></Field>
        <Field label="What it is"><textarea id="nv-message" className="sa-input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What this version of the graph is, and what changed in it" /></Field>
        <p className="sa-note">v{step.n} · {stepWhen(step.at)} · {stepSays(step)}</p>
        {since && since.length > 0 && <div className="sa-graphpage__block">
          <h3 className="sa-label">{since.length} change{since.length === 1 ? '' : 's'} since the last name</h3>
          <ul className="sa-versions__changes">{since.slice(-200).reverse().map((c) => (
            <li key={c.id}><Code>{c.name}</Code> <span className="sa-muted">{c.removed ? 'removed' : c.kind} · {c.by.replace(/^user:/, '')}{c.reason ? ` · ${c.reason}` : ''}</span></li>))}</ul>
        </div>}
      </Form>
    </Dialog>
  )
}

/** What is selected: all of it, and its editor. */
function Detail({ hub, node, kind, by, partOf, goTo, change, reload, intermediates, readOnly = false, openOnly = null, onEdit }: {
  hub: ReturnType<typeof useProjectHub>; node: Node; kind: NonNullable<Focus>['kind']; by: Map<string, Node>; partOf: Node[]; intermediates: Node[]; readOnly?: boolean
  openOnly?: string | null; onEdit: (name: string) => void
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
      <Composes owner={node} by={by} openOnly={openOnly} readOnly={readOnly} change={change} onEdit={onEdit} />
 {!readOnly && <AttachPick label="Attach an intermediate concept" options={intermediates.filter((x) => !node.concepts.includes(x.name))} onAttach={(k) => void change('graph:join', node.name, k)} />}
      <SystemPrompt hub={hub} domain={node.name} />
      {meta}
    </div>
  )
  if (kind === 'intermediate') return <IntermediateDetail readOnly={readOnly} hub={hub} node={node} reload={reload} meta={meta} order={order(node, 'Its atomic concepts')} links={links('Part of', partOf, 'No domain composes it yet.')}
    composed={composedText(String(b.title ?? node.title), String(b.text ?? ''), node.concepts.map((c) => by.get(c)).filter((x): x is Node => !!x))} />
  return <AtomicDetail readOnly={readOnly} hub={hub} node={node} reload={reload} meta={meta} links={links('Part of', partOf, 'Nothing composes it yet — attach it to an intermediate concept.')} />
}

/** What a domain composes, in its order, each concept opened in place to read: several may be open at once; a concept
 *  picked in its column closes the rest and opens alone. ↑ ↓ move between them, Enter opens or closes one. */
function Composes({ owner, by, openOnly, readOnly, change, onEdit }: { owner: Node; by: Map<string, Node>; openOnly: string | null; readOnly: boolean
  change: (t: 'graph:join' | 'graph:leave', into: string, concept: string, at?: number) => Promise<boolean>; onEdit: (name: string) => void }) {
  // The direct part that is the picked concept, or holds it (an intermediate concept).
  const partFor = (name: string | null) => (name ? owner.concepts.find((c) => c === name || by.get(c)?.concepts.includes(name)) ?? null : null)
  const [open, setOpen] = useState<Set<string>>(() => new Set(partFor(openOnly) ? [partFor(openOnly)!] : []))
  const heads = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const p = partFor(openOnly); if (!p) return
    setOpen(new Set([p]))
    requestAnimationFrame(() => heads.current[owner.concepts.indexOf(p)]?.closest('.sa-acc__item')?.scrollIntoView({ block: 'nearest' }))
  }, [openOnly])   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (c: string) => setOpen((o) => { const n = new Set(o); if (n.has(c)) n.delete(c); else n.add(c); return n })
  const keys = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? owner.concepts.length - 1 : null
    if (to === null || to < 0 || to >= owner.concepts.length) return
    e.preventDefault(); heads.current[to]?.focus()
  }
  const textOf = (n: Node) => (n.composed ? composedText(String(n.body.title ?? n.title), String(n.body.text ?? ''), n.concepts.map((c) => by.get(c)).filter((x): x is Node => !!x)) : toText(n.body))
  const all = open.size === owner.concepts.length && owner.concepts.length > 0
  return (
    <div className="sa-graphpage__block">
      <div className="sa-acc__bar">
        <h3 className="sa-label">What it composes <span className="sa-col__count">{owner.concepts.length}</span></h3>
        {owner.concepts.length > 0 && <button className="sa-btn sa-btn--link" onClick={() => setOpen(all ? new Set() : new Set(owner.concepts))}>{all ? 'Close all' : 'Open all'}</button>}
      </div>
      {!owner.concepts.length ? <p className="sa-note">Nothing yet — attach from the column.</p> : (
        <div className="sa-acc">
          {owner.concepts.map((c, i) => {
            const n = by.get(c), isOpen = open.has(c), text = n ? textOf(n) : ''
            return (
              <section key={c} className="sa-acc__item" data-open={isOpen}>
                <div className="sa-acc__head">
                  <button ref={(el) => { heads.current[i] = el }} className="sa-acc__toggle" aria-expanded={isOpen} onClick={() => toggle(c)} onKeyDown={(e) => keys(e, i)}>
                    <Icon icon="lucide:chevron-right" className="sa-acc__chev" />
                    <span className="sa-acc__n">{i + 1}</span>
                    <span className="sa-acc__title">{n?.title ?? c}</span>
                    {n?.composed && <span className="sa-col__tag">intermediate</span>}
                  </button>
                  {!readOnly && <span className="sa-acc__acts">
                    <button className="sa-icon-btn" disabled={i === 0} title="Move up" aria-label="Move up" onClick={() => void change('graph:join', owner.name, c, i - 1)}><Icon icon="lucide:arrow-up" /></button>
                    <button className="sa-icon-btn" disabled={i === owner.concepts.length - 1} title="Move down" aria-label="Move down" onClick={() => void change('graph:join', owner.name, c, i + 1)}><Icon icon="lucide:arrow-down" /></button>
                    <button className="sa-icon-btn" title="Edit" aria-label={`Edit ${n?.title ?? c}`} onClick={() => onEdit(c)}><Icon icon="lucide:pencil" /></button>
                    <button className="sa-icon-btn" title="Detach" aria-label="Detach" onClick={() => void change('graph:leave', owner.name, c)}><Icon icon="lucide:unlink" /></button>
                  </span>}
                </div>
                {isOpen && (text.trim() ? <div className="sa-acc__body sa-graphpage__md sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} /> : <p className="sa-acc__body sa-note">Empty.</p>)}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A new domain: what an agent will know from the start — empty, its concepts attached from the columns after. */
function NewDomain({ hub, onClose, onMade }: { hub: ReturnType<typeof useProjectHub>; onClose: () => void; onMade: (name: string) => void }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [err, setErr] = useState('')
  const name = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  const make = async () => {
    const r = await hub.call({ t: 'graph:domain', name, body: { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), capabilities: [], concepts: [], files: [] }, reason: 'made in the console' }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not made'); return }
    notify(`${title.trim()} made — attach its concepts from the columns`, 'note'); onMade(name)
  }
  return (
    <Dialog title="New domain" onClose={onClose}>
      <Form onSubmit={() => void make()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!name}>Make it</button></>}>
        <Field label="Title" help={name ? <>Named <Code>{name}</Code></> : undefined}><input id="nd-title" className="sa-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What the agent is about, in a few words" /></Field>
        <Field label="What it covers"><textarea id="nd-description" className="sa-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="The questions it answers and what it knows, in a sentence or two" /></Field>
      </Form>
    </Dialog>
  )
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

