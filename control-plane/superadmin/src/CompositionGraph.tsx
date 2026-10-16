// THE COMPOSITION GRAPH, as a page ("The composition graph in columns", docs/platform-architecture.md): a directed graph
// walked left to right — domains → intermediate concepts → atomic concepts. Nothing selected, a column holds every thing of
// its kind; selecting one changes the columns to its right to what it composes (an intermediate column with nothing in it
// is not shown). Beside the columns, what is selected: all of it, and its editor. Everything is done here — attach,
// detach, order, make, edit (or suggest, when it is someone else's). How the graph moved over time is its own view.
// Drawn only with the semantic components (@superatom/ui).

import { defaultConcept } from '../../shared/default-concepts'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Columns, ColumnsSearch, Dialog, markdownToHtml, Form, Field, Notice, Receipt, Code, Icon, notify, dateTime, type ColumnItem, type ColumnSpec } from '@superatom/ui'
import { useSearchParams } from 'react-router-dom'
import { useProjectHub } from './hub'
import { VersionGraph, type Line, type DraftNode } from './GraphHistory'
import { cached, keep } from './cache'

type Body = Record<string, any>
interface Node { name: string; title: string; line: string; scope: string; owner: string | null; hash: string; concepts: string[]; body: Body; composed?: boolean; form?: string; agents?: { name: string; title: string }[] }
type Change = { id: number; name: string; kind: string; by: string; reason: string | null; removed: boolean }
interface Version { id: number; name: string; message: string; upto: number; at: number; by: string; asOf: number; changes: number }
interface Graph { domains: Node[]; intermediate: Node[]; atomic: Node[]; version?: Version }
type Focus = { kind: 'domain' | 'intermediate' | 'atomic'; name: string } | null

/** A concept's content as Markdown — a list or worked examples written before concepts were Markdown read as their Markdown. */
const toText = (b: Body): string => b.form === 'text' ? String(b.text ?? '')
  : b.form === 'sections' ? sectionsText(b)
  : b.form === 'worked' ? (b.items ?? []).map((e: any) => `## ${e.question}\n${(e.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n')
  : b.form === 'numbered' ? (b.items ?? []).map((l: string, i: number) => `${i + 1}. ${l}`).join('\n')
  : (b.items ?? []).map((l: string) => `- ${l}`).join('\n')
/** A concept in sections as Markdown: each section a heading, an entity map or a calculation as code. */
const sectionsText = (b: Body): string => [
  ...(Array.isArray(b.uses) && b.uses.length ? [`Builds on: ${b.uses.join(', ')}.`] : []),
  ...(Array.isArray(b.sections) ? b.sections : []).map((x: any) => {
    const code = ['entity map', 'calculation'].includes(String(x?.name ?? '').toLowerCase())
    const items: string[] = Array.isArray(x?.items) ? x.items : []
    const body = code ? '```\n' + String(x?.text ?? items.join('\n')) + '\n```' : [x?.text, ...items.map((l) => `- ${l}`)].filter(Boolean).join('\n')
    return `### ${String(x?.name ?? '')}\n${body}`
  }),
].join('\n\n')
/** How an intermediate concept is composed: its title, its line, then each atomic concept beneath it — the sum of its parts. */
const composedText = (title: string, line: string, parts: Node[]) =>
  [`# ${title}${line.trim() ? `\n${line.trim()}` : ''}`, ...parts.map((p) => `## ${p.body.title ?? p.title}\n${toText(p.body).trim()}`)].join('\n\n')

export function CompositionGraph({ projectId, token }: { projectId: string; token: string | null }) {
  const hub = useProjectHub(projectId, token)
  // Shown at once from this browser's copy (cache.ts) when it was read before; the engine's answer replaces it.
  const who = (() => { try { return String(JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? '') } catch { return '' } })()
  // A named version being looked at (read-only), or null: the graph as it is now.
  // A published version being looked at (read-only), or null: the draft — the graph as it is, edited here.
  // WHERE ONE IS, IN THE URL — the version looked at (?v=), and the domain, group and concept open (?d= ?m= ?a=): a link
  // sent to someone opens the same place. Read once when the page opens, written as one moves.
  const [params, setParams] = useSearchParams()
  const at = useRef({ v: params.get('v'), d: params.get('d'), m: params.get('m'), a: params.get('a') })
  const [viewing, setViewing] = useState<Line | null>(null)
  const [versions, setVersions] = useState<{ versions: Line[]; published: string | null; draft: DraftNode[]; since: Change[]; people: Record<string, string> } | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const cacheKey = `${who}|graph|${projectId}${viewing ? `|v:${viewing.name}` : ''}`
  const [graph, setGraph] = useState<Graph | null>(() => { try { const c = cached(cacheKey); return c ? JSON.parse(c) as Graph : null } catch { return null } })
  const [err, setErr] = useState('')
  const [dom, setDom] = useState<string | null>(at.current.d)
  const [mid, setMid] = useState<string | null>(at.current.m)
  const [atom, setAtom] = useState<string | null>(at.current.a)
  const [focus, setFocus] = useState<Focus>(() => (at.current.a ? { kind: 'atomic', name: at.current.a } : at.current.m ? { kind: 'intermediate', name: at.current.m } : at.current.d ? { kind: 'domain', name: at.current.d } : null))
  // the version the URL names, once the versions are known (an unknown one: the draft)
  useEffect(() => {
    const v = at.current.v; if (!v || !versions) return
    at.current.v = null
    const line = versions.versions.find((x) => x.name === v)
    if (line) setViewing(line)
  }, [versions])
  // written as one moves: replace, not push — the place, not each click, is what a link and the back button carry
  useEffect(() => {
    const next = new URLSearchParams(params)
    for (const [k, val] of [['v', viewing?.name ?? at.current.v], ['d', dom], ['m', mid], ['a', atom]] as const) { if (val) next.set(k, val); else next.delete(k) }
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [viewing, dom, mid, atom])   // eslint-disable-line react-hooks/exhaustive-deps
  const [making, setMaking] = useState<null | { kind: 'intermediate' | 'atomic'; into: string | null }>(null)
  const [makingDomain, setMakingDomain] = useState(false)
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    try { const r = await hub.request('compositionColumns', viewing ? { version: viewing.name } : {}); if (r.error) setErr(r.error); else if (r.exists === false) setErr('This project has no composition graph yet.'); else { setErr(''); setGraph(r); keep(cacheKey, JSON.stringify(r)) } }
    catch (e: any) { setErr(e?.message ?? String(e)) }
  }, [hub.request, cacheKey, viewing])   // eslint-disable-line react-hooks/exhaustive-deps -- hub is a new object each render; its request is stable
  const loadVersions = useCallback(async () => {
    const r = await hub.call({ t: 'graph:versions' }).catch(() => null)
    if (r?.t === 'graph:reply') setVersions({ versions: r.versions ?? [], published: r.published ?? null, draft: r.draft ?? [], since: r.since ?? [], people: r.people ?? {} })
  }, [hub.call])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hub.status === 'live') { void load(); void loadVersions() } }, [hub.status, load, loadVersions])
  const [publishing, setPublishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [restoring, setRestoring] = useState<Line | null>(null)
  /** Look at a version (null: now): the graph as it read then, read-only. */
  // Looking at another version clears what was loaded so it is read again; picking the one already shown (the draft
  // while on the draft) changes nothing — clearing it then left nothing to read it again: loading forever.
  const view = (name: Line | null) => { if ((name?.name ?? null) === (viewing?.name ?? null)) return; setViewing(name); setDom(null); setMid(null); setAtom(null); setFocus(null); setGraph(null) }

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
  const item = (n: Node, via?: string): ColumnItem => {
    const o = originOf(n)
    return { key: n.name, title: n.title || n.name, line: n.line || (n.concepts.length ? `${n.concepts.length} concept${n.concepts.length === 1 ? '' : 's'}` : undefined),
      ...(o ? { badge: o === 'default' ? { label: 'Default' } : { label: 'Changed from default', tone: 'warn' as const } } : {}), ...(via ? { via } : {}) }
  }
  // what the selected domain holds through one of its intermediate concepts (not directly): that one's title, by atom
  const viaOf = new Map<string, string>()
  if (d && !m) for (const c of d.concepts) { const x = by.get(c); if (x?.composed) for (const a of x.concepts) if (!d.concepts.includes(a) && !viaOf.has(a)) viaOf.set(a, x.title || x.name) }
  const focusCol = focus?.kind === 'domain' ? 'domains' : focus?.kind ?? null

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
    { key: 'domains', title: 'Domains', icon: 'lucide:bot', items: graph.domains.filter(hit).map((n) => item(n)), selected: dom, focused: focusCol === 'domains', onSelect: (k) => select('domain', k), onNew: () => setMakingDomain(true), empty: needle ? 'No domain matches.' : 'No domains yet.' },
    {
      key: 'intermediate', title: 'Intermediate concepts', icon: 'lucide:layers',
      items: graph.intermediate.filter(hit).map((n) => item(n)), selected: mid, focused: focusCol === 'intermediate', onSelect: (k) => select('intermediate', k),
      ...(d ? { linked: d.concepts.filter(isMid), linkedTo: d.title, onAttach: (k: string) => void change('graph:join', d.name, k), onDetach: (k: string) => void change('graph:leave', d.name, k) } : {}),
      onNew: () => setMaking({ kind: 'intermediate', into: d?.name ?? null }),
      empty: needle ? 'No intermediate concept matches.' : 'No intermediate concepts yet — make one from atomic concepts.',
    },
    {
      key: 'atomic', title: 'Atomic concepts', icon: 'lucide:atom',
      items: graph.atomic.filter(hit).map((n) => item(n, viaOf.get(n.name))), selected: atom, focused: focusCol === 'atomic', onSelect: (k) => select('atomic', k),
      ...(atomTarget ? { linked: m ? m.concepts : reach(d!), linkedTo: atomTarget.title, onAttach: (k: string) => void change('graph:join', atomTarget.name, k), onDetach: detachAtom } : {}),
      onNew: () => setMaking({ kind: 'atomic', into: atomTarget?.name ?? null }),
      empty: needle ? 'No atomic concept matches.' : 'No atomic concepts yet.',
    },
  ]

  // Looking at a version: nothing is attached, detached or made — it is how the graph was.
  const shown = viewing ? columns.map((c) => ({ ...c, onAttach: undefined, onDetach: undefined, onNew: undefined })) : columns
  // A concept of the selected domain, picked in its column: the domain stays on the right, that concept open in it.
  const inDomain = !!(focus?.kind === 'atomic' && d && !m && reach(d).includes(focus.name))
  const focused = inDomain ? d : focus ? by.get(focus.name) ?? null : null
  const focusKind = inDomain ? 'domain' as const : focus?.kind
  const partOf = (name: string) => [...graph.intermediate, ...graph.domains].filter((x) => x.concepts.includes(name))
  return (
    <div className="sa-graphpage">
      <div className="sa-graphpage__top">
        <ColumnsSearch value={q} onChange={setQ} placeholder="Search domains and concepts — titles and what they say" />
        <VersionsButton versions={versions} viewing={viewing} onOpen={() => setVersionsOpen(true)} />
        {!viewing && versions && versions.draft.length > 0 && <span className="sa-draftbar">
          <button className="sa-btn" onClick={() => setDiscarding(true)} disabled={!versions.published} title={versions.published ? `Set the draft back to ${versions.published}` : 'Nothing published to go back to'}>Discard</button>
          <button className="sa-btn sa-btn--primary" onClick={() => setPublishing(true)}><Icon icon="lucide:upload" className="sa-btn__icon" />Publish v{versions.versions.length + 1}</button>
        </span>}
      </div>
      {viewing && (
        <div className="sa-graphpage__viewing" role="status">
          <Icon icon="lucide:history" /><span><strong>{viewing.name}</strong> — {viewing.message} <span className="sa-muted">· published {dateTime(viewing.at)} · read-only</span></span>
          <span className="sa-graphpage__viewacts">
            {viewing.name !== versions?.published && <button className="sa-btn" onClick={() => setRestoring(viewing)}><Icon icon="lucide:rotate-ccw" className="sa-btn__icon" />Bring into the draft</button>}
            <button className="sa-btn sa-btn--primary" onClick={() => view(null)}>Back to the draft</button>
          </span>
        </div>
      )}
      <Columns keep="composition-graph" columns={shown} detail={focused
        ? <Detail key={focused.name} hub={hub} node={focused} kind={focusKind!} by={by} partOf={partOf(focused.name)} goTo={goTo} change={change} reload={load} intermediates={graph.intermediate} readOnly={!!viewing}
            openOnly={inDomain ? focus!.name : null} />
        : <div className="sa-graphpage__hint"><Icon icon="lucide:mouse-pointer-click" /><p>Select a domain or a concept to see all of it here, change it, and walk what it composes.</p>
            <Receipt items={[['Domains', String(graph.domains.length)], ['Intermediate concepts', String(graph.intermediate.length)], ['Atomic concepts', String(graph.atomic.length)]]} /></div>} />
      {making?.kind === 'atomic' && <NewConcept hub={hub} kind="atomic" into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {making?.kind === 'intermediate' && <NewIntermediate hub={hub} atomic={graph.atomic} preset={atom ? [atom] : []} into={making.into ? by.get(making.into)?.title ?? making.into : null}
        onClose={() => setMaking(null)} onMade={async (name) => { if (making.into) await change('graph:join', making.into, name); else await load(); setMaking(null); goTo(name) }} />}
      {versionsOpen && versions && (
        <Dialog title="Versions" onClose={() => setVersionsOpen(false)} actions={<button className="sa-btn" onClick={() => setVersionsOpen(false)}>Close</button>}>
          <p className="sa-note">Edits are a draft; publishing makes the next version, and the agents read the latest one. Bringing an older version into the draft and publishing it starts a new line from it.</p>
          <div className="sa-history__scroll">
            <VersionGraph versions={versions.versions} published={versions.published} draft={versions.draft} people={versions.people} current={viewing?.name ?? null}
              onPick={(v) => { setVersionsOpen(false); view(v) }}
              actions={(v) => v.name !== versions.published ? <button className="sa-btn sa-btn--link" onClick={() => { setVersionsOpen(false); setRestoring(v) }}><Icon icon="lucide:rotate-ccw" className="sa-btn__icon" />Bring into the draft</button> : null}
              draftActions={versions.draft.length > 0 ? <button className="sa-btn sa-btn--primary" onClick={() => { setVersionsOpen(false); setPublishing(true) }}><Icon icon="lucide:upload" className="sa-btn__icon" />Publish v{versions.versions.length + 1}</button> : undefined} />
          </div>
        </Dialog>
      )}
      {publishing && versions && <PublishDraft hub={hub} next={`v${versions.versions.length + 1}`} draft={versions.draft} by={by} onClose={() => setPublishing(false)} onDone={() => { setPublishing(false); void loadVersions() }} />}
      {makingDomain && <NewDomain hub={hub} onClose={() => setMakingDomain(false)} onMade={async (name) => { setMakingDomain(false); await load(); void loadVersions(); goTo(name) }} />}
      {discarding && versions?.published && (
        <Dialog title="Discard the draft?" onClose={() => setDiscarding(false)}
          actions={<><button className="sa-btn" onClick={() => setDiscarding(false)}>Keep editing</button><button className="sa-btn sa-btn--primary" onClick={async () => {
            const r = await hub.call({ t: 'graph:restore', name: versions.published }).catch((e) => ({ reason: String(e?.message ?? e) }))
            setDiscarding(false)
            if (r?.t !== 'graph:reply') { notify(r?.reason ?? 'It was not discarded', 'refused'); return }
            notify(`The draft is ${versions.published} again`, 'note'); await load(); void loadVersions()
          }}>Discard {versions.draft.length} change{versions.draft.length === 1 ? '' : 's'}</button></>}>
          <p>Every node that differs from {versions.published} is set back to how it is there. The edits stay in the change log, so nothing is lost.</p>
        </Dialog>
      )}
      {restoring && (
        <Dialog title={`Bring ${restoring.name} into the draft?`} onClose={() => setRestoring(null)}
          actions={<><button className="sa-btn" onClick={() => setRestoring(null)}>Cancel</button><button className="sa-btn sa-btn--primary" onClick={async () => {
            const v = restoring
            const r = await hub.call({ t: 'graph:restore', name: v.name }).catch((e) => ({ reason: String(e?.message ?? e) }))
            setRestoring(null)
            if (r?.t !== 'graph:reply') { notify(r?.reason ?? 'It was not brought back', 'refused'); return }
            notify(`The draft is ${v.name} now — publish it to make it live`, 'note'); view(null); void loadVersions()
          }}>Bring it into the draft</button></>}>
          <p>The draft becomes the graph as it was in {restoring.name}. The agents keep reading {versions?.published ?? 'the published version'} until you publish; publishing starts a new line from {restoring.name}.</p>
        </Dialog>
      )}
    </div>
  )
}

/** Where the graph is, in one button: the version the agents read, and what is in the draft — or the version looked at. */
function VersionsButton({ versions, viewing, onOpen }: { versions: { published: string | null; draft: DraftNode[] } | null; viewing: Line | null; onOpen: () => void }) {
  const n = versions?.draft.length ?? 0
  const said = viewing ? `Looking at ${viewing.name}` : !versions ? 'Versions' : !versions.published ? 'Nothing published yet' : `${versions.published} live${n ? ` · ${n} change${n === 1 ? '' : 's'} in draft` : ''}`
  return (
    <button className="sa-versions" onClick={onOpen} disabled={!versions} data-viewing={!!viewing} data-draft={n > 0} title="The graph's versions: what the agents read, and the draft">
      <Icon icon="lucide:git-branch" className="sa-versions__icon" /><span className="sa-versions__said">{said}</span><Icon icon="lucide:chevron-down" className="sa-versions__icon" />
    </button>
  )
}

/** Publish the draft: what changed, node by node, and a line saying what this version is. */
function PublishDraft({ hub, next, draft, by, onClose, onDone }: { hub: ReturnType<typeof useProjectHub>; next: string; draft: DraftNode[]; by: Map<string, Node>; onClose: () => void; onDone: () => void }) {
  const [message, setMessage] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    const r = await hub.call({ t: 'graph:version', message: message.trim() }).catch((e) => ({ reason: String(e?.message ?? e) }))
    setBusy(false)
    if (r?.t !== 'graph:reply') { setErr(r?.reason ?? 'It was not published'); return }
    notify(`Published ${r.version?.name ?? next} — new chats use it`, 'note'); onDone()
  }
  const what = (d: DraftNode) => (d.was === null ? 'added' : d.now === null ? 'removed' : 'changed')
  return (
    <Dialog title={`Publish ${next}`} onClose={onClose}>
      <Form onSubmit={() => void go()} error={err} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!message.trim() || busy}>Publish {next}</button></>}>
        <div className="sa-graphpage__block">
          <h3 className="sa-label">{draft.length} change{draft.length === 1 ? '' : 's'}</h3>
          <ul className="sa-versions__changes">{draft.map((d) => (
            <li key={d.name}><span className="sa-pill" data-state={what(d) === 'removed' ? 'critical' : what(d) === 'added' ? 'ok' : 'neutral'}>{what(d)}</span> {by.get(d.name)?.title ?? d.name} <span className="sa-muted">{d.kind}</span></li>))}</ul>
        </div>
        <Field label="What this version is"><textarea id="pv-message" className="sa-input" rows={3} autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed, for whoever reads the history" /></Field>
        <p className="sa-note">The agents read {next} from their next chat; chats already open keep what they started with.</p>
      </Form>
    </Dialog>
  )
}

/** What is selected: all of it, and its editor. */
function Detail({ hub, node, kind, by, partOf, goTo, change, reload, intermediates, readOnly = false, openOnly = null }: {
  hub: ReturnType<typeof useProjectHub>; node: Node; kind: NonNullable<Focus>['kind']; by: Map<string, Node>; partOf: Node[]; intermediates: Node[]; readOnly?: boolean
  openOnly?: string | null
  goTo: (name: string) => void; change: (t: 'graph:join' | 'graph:leave', into: string, concept: string, at?: number) => Promise<boolean>; reload: () => Promise<void>
}) {
  const b = node.body
  // A part edited in place: its row opens to its editor (the rest close).
  const [editingPart, setEditingPart] = useState<string | null>(null)
  // Its order, moved at once on the screen and saved behind it; set back if the save is refused. The graph's own order
  // replaces it whenever that changes (after a save, or someone else's edit).
  const [order, setOrder] = useState(node.concepts)
  useEffect(() => { setOrder(node.concepts) }, [node.concepts.join('\u0000')])   // eslint-disable-line react-hooks/exhaustive-deps
  const move = (c: string, from: number, to: number) => {
    setOrder((o) => { const x = [...o]; x.splice(from, 1); x.splice(to, 0, c); return x })
    void change('graph:join', node.name, c, to).then((ok) => { if (!ok) setOrder(node.concepts) })
  }
  const textOf = (n: Node) => (n.composed ? composedText(String(n.body.title ?? n.title), String(n.body.text ?? ''), n.concepts.map((c) => by.get(c)).filter((x): x is Node => !!x)) : toText(n.body))
  /** Its parts, in order: each a numbered row that opens to its text, moved, edited or detached on hover. */
  const parts = (owner: Node): AccItem[] => order.map((c, i) => {
    const n = by.get(c)
    return {
      key: c, n: i + 1, title: n?.title ?? c, tag: n ? <>{n.composed && <span className="sa-col__tag">intermediate</span>}{originOf(n) && <span className="sa-pill sa-col__badge" data-state={originOf(n) === 'changed' ? 'warning' : undefined}>{originOf(n) === 'default' ? 'Default' : 'Changed from default'}</span>}</> : undefined,
      acts: readOnly ? undefined : <>
        <button className="sa-icon-btn" disabled={i === 0} title="Move up" aria-label="Move up" onClick={() => move(c, i, i - 1)}><Icon icon="lucide:arrow-up" /></button>
        <button className="sa-icon-btn" disabled={i === order.length - 1} title="Move down" aria-label="Move down" onClick={() => move(c, i, i + 1)}><Icon icon="lucide:arrow-down" /></button>
        {n && editingPart !== c && <EditButton label={n.title} onClick={() => setEditingPart(c)} />}
        <button className="sa-icon-btn" title="Detach" aria-label="Detach" onClick={() => void change('graph:leave', owner.name, c)}><Icon icon="lucide:unlink" /></button>
      </>,
      body: () => n && editingPart === c ? <ConceptEditor hub={hub} node={n} reload={reload} onDone={() => setEditingPart(null)} /> : <Read text={n ? textOf(n) : ''} />,
    }
  })
  const partOfRow = (empty: string): AccItem => ({ key: 'part-of', icon: 'lucide:git-merge', title: `Part of${partOf.length ? ` · ${partOf.length}` : ''}`,
    body: () => partOf.length ? <div className="sa-words">{partOf.map((x) => <button key={x.name} className="sa-word sa-graphpage__link" onClick={() => goTo(x.name)}>{x.title}</button>)}</div> : <p className="sa-note">{empty}</p> })
  const detailsRow: AccItem = { key: 'details', icon: 'lucide:info', title: 'Name, owner and version',
    body: () => <Receipt items={[['Name', <Code key="n">{node.name}</Code>], ['Owner', node.owner ?? 'nobody (imported)'], ['Seen by', node.scope === 'global' ? 'everyone' : node.scope], ['Version', <Code key="h">{node.hash.slice(0, 12)}</Code>]]} /> }
  // A concept picked in its column opens the part that is it, or holds it.
  const partFor = (name: string | null) => (name ? node.concepts.find((c) => c === name || by.get(c)?.concepts.includes(name)) ?? null : null)

  if (kind === 'domain') return (
    <div className="sa-graphpage__detail">
      <Accordion openOnly={editingPart ?? partFor(openOnly)} initial={['head']} items={[
        { key: 'head', icon: 'lucide:bot', title: node.title, body: () => <>
          <p className="sa-note">A domain — what an agent knows from the start, composed in this order</p>
          {b.description && <p className="sa-graphpage__text">{b.description}</p>}
          {(b.intents ?? []).length > 0 && <OneLine words={b.intents} />}
        </> },
        ...parts(node),
        { key: 'setup', icon: 'lucide:wrench', title: 'Agents, tools and screens', body: () => <Receipt items={[
          ['Agents', node.agents?.length ? node.agents.map((a) => a.title).join(', ') : '—'],
          ['Tools', (b.tools ?? []).length ? <div className="sa-words">{b.tools.map((t: string) => <span key={t} className="sa-word">{t}</span>)}</div> : 'all'],
          ['Screens', (b.capabilities ?? []).length ? <div className="sa-words">{b.capabilities.map((t: string) => <span key={t} className="sa-word">{t}</span>)}</div> : '—'],
          ['Programs and files', (b.files ?? []).length ? `${b.files.length}` : '—'],
        ]} /> },
        { key: 'prompt', icon: 'lucide:scroll-text', title: 'The system prompt it composes to', body: () => <SystemPrompt hub={hub} domain={node.name} /> },
        ...(readOnly ? [] : [{ key: 'attach', icon: 'lucide:link', title: 'Attach an intermediate concept', body: () => <AttachPick label="Attach an intermediate concept" options={intermediates.filter((x) => !node.concepts.includes(x.name))} onAttach={(k) => void change('graph:join', node.name, k)} /> }]),
        detailsRow,
      ]} />
    </div>
  )
  if (kind === 'intermediate') return <IntermediateDetail readOnly={readOnly} hub={hub} node={node} reload={reload}
    rows={[...parts(node),
      { key: 'composed', icon: 'lucide:file-text', title: 'What it composes to', body: () => <pre className="sa-graphpage__prompt">{textOf(node)}</pre> },
      partOfRow('No domain composes it yet.'), detailsRow]} />
  return <AtomicDetail readOnly={readOnly} hub={hub} node={node} reload={reload} rows={[partOfRow('Nothing composes it yet — attach it to an intermediate concept.'), detailsRow]} />
}

/** One row of a detail's accordion: a number (a composed part, in its order) or an icon (anything else), its title, its
 *  actions on hover, and what it opens to — drawn only when open. */
interface AccItem { key: string; title: ReactNode; n?: number; icon?: string; tag?: ReactNode; acts?: ReactNode; body: () => ReactNode }

/** Everything about the selected node, in one accordion: several rows may be open at once; `openOnly` (a concept picked in
 *  its column) closes the rest and opens alone. ↑ ↓ move between rows, Enter opens or closes one. */
function Accordion({ items, openOnly = null, initial = [] }: { items: AccItem[]; openOnly?: string | null; initial?: string[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(openOnly ? [openOnly] : initial))
  const heads = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    if (!openOnly) return
    setOpen(new Set([openOnly]))
    // Into view within the detail panel only — scrollIntoView would also slide the columns sideways.
    requestAnimationFrame(() => {
      const item = heads.current[items.findIndex((x) => x.key === openOnly)]?.closest('.sa-acc__item') as HTMLElement | null
      const pane = item?.closest('.sa-col--detail') as HTMLElement | null
      if (!item || !pane) return
      const ir = item.getBoundingClientRect(), pr = pane.getBoundingClientRect()
      if (ir.top < pr.top) pane.scrollTop -= pr.top - ir.top + 8
      else if (ir.bottom > pr.bottom) pane.scrollTop += Math.min(ir.bottom - pr.bottom + 8, ir.top - pr.top - 8)
    })
  }, [openOnly])   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const keys = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (to === null || to < 0 || to >= items.length) return
    e.preventDefault(); heads.current[to]?.focus()
  }
  const all = items.length > 0 && items.every((x) => open.has(x.key))
  const openAll = <button className="sa-btn sa-btn--link" onClick={() => setOpen(all ? new Set() : new Set(items.map((x) => x.key)))}>{all ? 'Close all' : 'Open all'}</button>
  return (
    <div className="sa-acc sa-acc--flat">
        {items.map((it, i) => {
          const isOpen = open.has(it.key)
          return (
            <section key={it.key} className="sa-acc__item" data-open={isOpen} data-head={i === 0 || undefined}>
              <div className="sa-acc__head">
                <button ref={(el) => { heads.current[i] = el }} className="sa-acc__toggle" aria-expanded={isOpen} onClick={() => toggle(it.key)} onKeyDown={(e) => keys(e, i)}>
                  <Icon icon="lucide:chevron-right" className="sa-acc__chev" />
                  <span className="sa-acc__n">{it.n !== undefined ? it.n : it.icon ? <Icon icon={it.icon} /> : null}</span>
                  <span className="sa-acc__title">{it.title}</span>
                  {it.tag}
                </button>
                {(it.acts || i === 0) && <span className="sa-acc__acts">{it.acts}{i === 0 && openAll}</span>}
              </div>
              {isOpen && <div className="sa-acc__body">{it.body()}</div>}
            </section>
          )
        })}
    </div>
  )
}

/** Words in one line — as many as fit — and the rest behind "+N more". */
function OneLine({ words }: { words: string[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false), [hidden, setHidden] = useState(0)
  useEffect(() => {
    const el = box.current; if (!el || all) return
    const count = () => { const top = (el.firstElementChild as HTMLElement | null)?.offsetTop ?? 0; setHidden([...el.children].filter((c) => (c as HTMLElement).dataset.word && (c as HTMLElement).offsetTop > top).length) }
    count(); const ro = new ResizeObserver(count); ro.observe(el); return () => ro.disconnect()
  }, [words, all])
  return (
    <div className="sa-oneline" data-all={all}>
      <div ref={box} className="sa-words sa-oneline__words">{words.map((t) => <span key={t} data-word="1" className="sa-word">{t}</span>)}</div>
      {(hidden > 0 || all) && <button className="sa-btn sa-btn--link sa-oneline__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `+${hidden} more`}</button>}
    </div>
  )
}

/** A concept's text, read. */
const Read = ({ text }: { text: string }) => text.trim() ? <div className="sa-graphpage__md sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} /> : <p className="sa-note">Empty.</p>

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

/** A concept's editor, in place: an atomic concept's title and Markdown, an intermediate concept's title and its own line —
 *  then save (or, when it is someone else's, suggest the change). */
function ConceptEditor({ hub, node, reload, onDone }: { hub: ReturnType<typeof useProjectHub>; node: Node; reload: () => Promise<void>; onDone: () => void }) {
  const mid = !!node.composed
  const [title, setTitle] = useState(String(node.body.title ?? node.title))
  // One Markdown text: a concept written in another form (a list, worked examples) opens as its Markdown and is kept so.
  const [text, setText] = useState(mid ? String(node.body.text ?? '') : toText(node.body))
  const [reason, setReason] = useState('')
  const s = useSave(hub, node.name, reload)
  const body = mid ? { ...node.body, title: title.trim(), ...(text.trim() ? { text: text.trim() } : { text: undefined }) } : { title: title.trim(), form: 'text', text }
  return (
    <Form onSubmit={() => void s.save(body, reason).then((ok) => ok && onDone())} error={s.err}
      actions={<>{s.suggestable && <button type="button" className="sa-btn" onClick={() => void s.suggest(body, reason).then((ok) => ok && onDone())}>Suggest this change</button>}
        <button type="button" className="sa-btn" onClick={onDone}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!title.trim() || (!mid && !text.trim()) || s.saving}>Save</button></>}>
      <Field label="Title"><input id={`ed-title-${node.name}`} className="sa-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for what it covers" /></Field>
      {mid
        ? <Field label="A line of its own (composed above its atomic concepts)"><textarea id={`ed-line-${node.name}`} className="sa-input" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        : <Field label="What the agent should know" help="Markdown — composed into the agent's context as written.">
            <textarea id={`ed-text-${node.name}`} className="sa-input sa-graphpage__editor" rows={18} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write it in Markdown: paragraphs, lists, headings, examples." />
          </Field>}
      <Field label="Why (kept in its history)"><input id={`ed-why-${node.name}`} className="sa-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What changed, and from what evidence" /></Field>
    </Form>
  )
}

const EditButton = ({ label, onClick }: { label: string; onClick: () => void }) =>
  <button className="sa-icon-btn" title="Edit" aria-label={`Edit ${label}`} onClick={onClick}><Icon icon="lucide:pencil" /></button>

/** Where a concept comes from: one of the platform's defaults as every project gets it ('default'), one of them changed
 *  here ('changed'), or the project's own (null). */
function originOf(n: Node): 'default' | 'changed' | null {
  const def = defaultConcept(n.name)
  if (!def) return null
  const same = def.body.form === 'composed'
    ? n.composed && String(n.body.title ?? n.title) === def.body.title && JSON.stringify(n.concepts) === JSON.stringify(def.body.concepts)
    : !n.composed && String(n.body.title ?? n.title) === def.body.title && toText(n.body) === def.body.text
  return same ? 'default' : 'changed'
}

/** The line under a concept's title that says where it comes from — nothing for the project's own. */
function Origin({ node }: { node: Node }) {
  const o = originOf(node)
  if (!o) return null
  return <p className="sa-note">{o === 'default' ? 'A default every project starts with — as the platform gives it.' : 'One of the defaults every project starts with, changed in this project.'}</p>
}

/** The selected concept's edit, said in a word (always shown, not only on hover). */
const EditLink = ({ onClick }: { onClick: () => void }) => <button className="sa-btn sa-btn--link" onClick={onClick}><Icon icon="lucide:pencil" className="sa-btn__icon" />Edit</button>

function AtomicDetail({ hub, node, reload, rows, readOnly = false }: { readOnly?: boolean; hub: ReturnType<typeof useProjectHub>; node: Node; reload: () => Promise<void>; rows: AccItem[] }) {
  const [editing, setEditing] = useState(false)
  // one of the project's default concepts (shared/default-concepts.ts), changed from its default: it can be set back
  const def = defaultConcept(node.name)
  const changed = !!def && def.body.form === 'text' && (String(node.body.title ?? node.title) !== def.body.title || toText(node.body) !== def.body.text)
  const s = useSave(hub, node.name, reload)
  return (
    <div className="sa-graphpage__detail">
      <Accordion openOnly={editing ? 'head' : null} initial={['head']} items={[
        { key: 'head', icon: 'lucide:atom', title: node.title, acts: !editing && !readOnly ? <>{changed && <button className="sa-btn sa-btn--link" disabled={s.saving} title="Set it back to the text every project starts with" onClick={() => void s.save(def!.body, 'reset to the default')}>Reset to the default</button>}<EditLink onClick={() => setEditing(true)} /></> : undefined,
          body: () => editing ? <ConceptEditor hub={hub} node={node} reload={reload} onDone={() => setEditing(false)} /> : <><Origin node={node} /><Read text={toText(node.body)} /></> },
        ...rows,
      ]} />
    </div>
  )
}

function IntermediateDetail({ hub, node, reload, rows, readOnly = false }: { readOnly?: boolean; hub: ReturnType<typeof useProjectHub>; node: Node; reload: () => Promise<void>; rows: AccItem[] }) {
  const [editing, setEditing] = useState(false)
  // one of the project's default composite concepts, changed from its default (its title, or which atoms, in what order)
  const def = defaultConcept(node.name)
  const changed = !!def && def.body.form === 'composed' && (String(node.body.title ?? node.title) !== def.body.title || JSON.stringify(node.body.concepts ?? []) !== JSON.stringify(def.body.concepts))
  const s = useSave(hub, node.name, reload)
  return (
    <div className="sa-graphpage__detail">
      <Accordion openOnly={editing ? 'head' : null} initial={['head']} items={[
        { key: 'head', icon: 'lucide:layers', title: node.title, acts: !editing && !readOnly ? <>{changed && <button className="sa-btn sa-btn--link" disabled={s.saving} title="Set it back to the atoms every project starts with" onClick={() => void s.save(def!.body, 'reset to the default')}>Reset to the default</button>}<EditLink onClick={() => setEditing(true)} /></> : undefined,
          body: () => editing ? <ConceptEditor hub={hub} node={node} reload={reload} onDone={() => setEditing(false)} /> : <>
            <p className="sa-note">An intermediate concept — a combination of atomic concepts, in this order</p>
            <Origin node={node} />
            {node.body.text ? <p className="sa-graphpage__text">{node.body.text}</p> : null}
          </> },
        ...rows,
      ]} />
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

/** The whole system prompt a domain composes to — composed when its row is opened. */
function SystemPrompt({ hub, domain }: { hub: ReturnType<typeof useProjectHub>; domain: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => { void hub.request('compositionCompose', { domain }).then((r) => setText(r.text ?? r.error ?? '')).catch((e) => setText(String(e?.message ?? e))) }, [hub, domain])
  return text === null ? <p className="sa-note">Composing…</p> : <pre className="sa-graphpage__prompt">{text}</pre>
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

