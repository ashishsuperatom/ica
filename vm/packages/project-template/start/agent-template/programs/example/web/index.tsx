// The program's React side: its views, exported as usual, each drawn with { slice, state } beside the step's answer —
// and, at the end, `views`: what it draws, by reference (defineViews: each view, what it reads and the moves it makes). Most of a step is the framework's, drawn from the answer: the filter row
// (declared in `program` on the server, its choices computed there), the figures, the words, the sections — so a block of
// the program's own holds only what is its own. Controls are <Intent>s — the one way a screen changes STATE: one that
// narrows the same view changes it in place (to="current", the default); one that opens another view or records a
// decision opens a new block (to="new"). A value a person picks is always one the data offers — never typed into a box.
// Build from the framework (@superatom/ui): what it lacks goes into the framework, not into one program.
import { Intent, ActionBar, defineViews, view } from '@superatom/ui'

type Slice = { group: string | null; key: string | null }

/** With a key opened: the way back to every key, in place. */
export function Example({ slice }: { slice?: Slice }) {
  if (!slice?.key) return null
  return (
    <ActionBar>
      <Intent ops={[{ op: 'set', path: 'example.key', value: null }]} className="sa-btn">Every key</Intent>
    </ActionBar>
  )
}

export const views = defineViews({
  Example: view(Example, { doc: 'With a key opened: the way back to every key', reads: ['key'], sends: [{ set: 'key' }] }),
})
