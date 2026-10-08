// The program's React side: one export per ui block, named in PascalCase (block "example" → Example), drawn with
// { slice, state }. Controls are <Intent>s (or sendIntent from a form) — the one way a screen changes STATE. A control
// that filters or drills the same view changes it in place (to="current", the default); one that opens another view or
// records a decision opens a new block (to="new"). Build from the framework (@superatom/ui): Form, Field, Input,
// ActionBar, the answer's own blocks for tables and charts — what it lacks goes into the framework, not into one program.
import { useRef, useState } from 'react'
import { Intent, Form, Field, Input, ActionBar, sendIntent } from '@superatom/ui'

type Slice = { filter: string | null; data: { rows: { key: string; value: number }[] } | null }

export function Example({ slice }: { slice?: Slice }) {
  const box = useRef<HTMLDivElement>(null)
  const [key, setKey] = useState('')
  if (!slice?.data) return null
  const narrow = () => { if (key.trim() && box.current) { sendIntent(box.current, { ops: [{ op: 'set', path: 'example.filter', value: key.trim() }] }); setKey('') } }
  return (
    <div ref={box} className="sa-stack">
      <Form onSubmit={narrow} actions={<button type="submit" className="sa-btn sa-btn--secondary" disabled={!key.trim()}>Narrow</button>}>
        <Field label="A key" help="the view narrows to it, in place">
          <Input id="example-key" value={key} placeholder="a key" onChange={setKey} />
        </Field>
      </Form>
      {slice.filter && (
        <ActionBar>
          <Intent ops={[{ op: 'set', path: 'example.filter', value: null }]} className="sa-btn sa-btn--secondary">Every key</Intent>
        </ActionBar>
      )}
    </div>
  )
}
