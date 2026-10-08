// ── Lineage, for one project ─────────────────────────────────────────────────────────────────────────────────────────
// How the data flows: what each dataset is made from and what reads it — a map the platform keeps (lineage.ts), told by
// the pipelines themselves (OpenLineage events, posted with a project key), by people and agents, and (planned) read
// from the sources' views and from our own reads. Here: the map as a list of "made from" links, who said each, and a
// link declared by hand. Drawn only with the semantic components (@superatom/ui).
import { useEffect, useState } from 'react'
import { Section, Form, Field, RecordList, Notice, Code, Status } from '@superatom/ui'
import type { useProjectHub } from './hub'

type Edge = { id: number; from: string; to: string; how: string | null; saidBy: string; who: string | null; at: string; lastSeen: string }
const SAID: Record<string, string> = { pipeline: 'a pipeline', source: 'the source', person: 'a person', agent: 'an agent', usage: 'our reads' }
/** A dataset id in words: its kind, then its name. */
const named = (id: string) => { const [kind, ...rest] = id.split(':'); return <span className="sa-row sa-row--tight"><Status state="neutral">{kind}</Status><Code>{rest.join(':')}</Code></span> }

export function LineagePanel({ hub, projectId }: { hub: ReturnType<typeof useProjectHub>; projectId: string }) {
  const [edges, setEdges] = useState<Edge[] | null>(null)
  const [count, setCount] = useState(0)
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ from: '', to: '', how: '' })
  const load = () => hub.kept({ t: 'lineage:map' }, (r: any) => { if (r.reason) setErr(r.reason); else { setEdges(r.edges ?? []); setCount((r.datasets ?? []).length) } }).catch(() => {})
  useEffect(() => { void load() }, [hub])   // eslint-disable-line react-hooks/exhaustive-deps
  const act = (payload: Record<string, unknown>, then?: () => void) => hub.call(payload).then((r: any) => { if (r.reason) setErr(r.reason); else { setErr(''); then?.(); void load() } }).catch((e: any) => setErr(e.message))
  const ready = !!form.from.trim() && !!form.to.trim()

  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      <Section icon="lucide:git-merge" title="Made from" subtitle="Each link: a dataset, what it is made from, how, and who told us" note={edges?.length ? `${edges.length} links · ${count} datasets` : undefined}>
        <RecordList rows={edges} keyOf={(e) => String(e.id)} empty="No links yet: a pipeline tells them, or declare one below."
          columns={[
            { key: 'from', label: 'From', render: (e) => named(e.from) },
            { key: 'to', label: 'Makes', render: (e) => named(e.to) },
            { key: 'how', label: 'How', wrap: true, render: (e) => e.how ?? <span className="sa-faint">—</span> },
            { key: 'said', label: 'Told by', render: (e) => <span className="sa-muted">{SAID[e.saidBy] ?? e.saidBy}{e.who && e.saidBy !== 'pipeline' ? ` · ${e.who}` : ''}</span> },
            { key: 'remove', label: '', align: 'end', render: (e) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void act({ t: 'lineage:remove', id: e.id })}>Remove</button> },
          ]} />
      </Section>

      <Section icon="lucide:link" title="Declare a link" subtitle="What a pipeline does not tell: one dataset made from another">
        <Form onSubmit={() => { if (ready) void act({ t: 'lineage:declare', edges: [{ from: form.from.trim(), to: form.to.trim(), how: form.how.trim() || undefined }] }, () => setForm({ from: '', to: '', how: '' })) }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!ready}>Declare</button>}>
          <Field label="From" help={<>A dataset: <Code>source:SOURCE/table</Code>, <Code>warehouse:ns.table</Code>, <Code>program:name</Code>…</>}>
            <input id="lin-from" className="sa-input" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="source:ERP/orders" />
          </Field>
          <Field label="Makes">
            <input id="lin-to" className="sa-input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="warehouse:sales.orders_daily" />
          </Field>
          <Field label="How (optional)">
            <input id="lin-how" className="sa-input" value={form.how} onChange={(e) => setForm({ ...form, how: e.target.value })} placeholder="Summed per day, cancelled orders left out" />
          </Field>
        </Form>
      </Section>

      <Section icon="lucide:workflow" title="Pipelines tell it themselves" subtitle="Any pipeline that speaks OpenLineage (dbt, Airflow, Spark…) sends its run events here">
        <div className="sa-section__body sa-stack">
          <p className="sa-muted">Post each run event, with a key of this project:</p>
          <Code>{`POST https://superatom.site/api/projects/${projectId}/lineage/openlineage   Authorization: Bearer <project key>`}</Code>
          <p className="sa-faint">Its inputs and outputs become datasets (ol:namespace/name) and its job the step between them; link a pipeline's dataset to one of ours with a declared link.</p>
        </div>
      </Section>
    </div>
  )
}
