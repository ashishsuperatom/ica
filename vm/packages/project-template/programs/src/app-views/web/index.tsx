// The project's views in a session, drawn with the platform's question components: above the answer, the question's
// controls (each change one move on this step, in place); below it, the next moves (each a new step) and what the
// numbers stand on. What the controls offer is the application's description of its views (app:catalog), asked once.

import { useEffect, useRef, useState } from 'react'
import { Intent, QuestionControls, NextMoves as Moves, AboutNumbers, sendIntent, useProgramEnv, type QuestionCatalog } from '@superatom/ui'

type Slice = { question: any; title: string; next: { label: string; ops: unknown[] }[]; about?: any }

let catalog: Promise<QuestionCatalog | null> | null = null
function useCatalog(): QuestionCatalog | null {
  const env = useProgramEnv()
  const [c, setC] = useState<QuestionCatalog | null>(null)
  useEffect(() => {
    if (!env) return
    catalog ??= env.request({ t: 'app:catalog' }).then((r) => (r?.t === 'app:catalog' ? (r.catalog ?? r) : null), () => null).then((x) => { if (!x) catalog = null; return x })
    let live = true
    void catalog.then((x) => { if (live) setC(x) })
    return () => { live = false }
  }, [env])
  return c
}

export function Controls({ slice }: { slice?: Slice }) {
  const env = useProgramEnv()
  const c = useCatalog()
  const box = useRef<HTMLDivElement>(null)
  if (!slice?.question || !c) return null
  return (
    <div ref={box}>
      <QuestionControls catalog={c} question={slice.question} used={slice.about?.used ?? {}} today={slice.about?.today} seen={slice.about?.seen ?? {}}
        members={env ? (dim, typed) => env.request({ t: 'app:members', dim, typed }).then((r) => (r?.t === 'app:members' ? r.matches : [])) : undefined}
        onEdit={(ops) => { if (box.current) sendIntent(box.current, { call: { package: 'view', fn: 'move', params: { ops } } }) }} />
    </div>
  )
}

export function NextMoves({ slice }: { slice?: Slice }) {
  return <Moves moves={slice?.next ?? []} render={(n, i, inner) => (
    <Intent key={i} call={{ package: 'view', fn: 'move', params: { ops: n.ops as any } }} to="new" className="sa-btn sa-btn--pill" title={n.label}>{inner}</Intent>
  )} />
}

export function About({ slice }: { slice?: Slice }) {
  return <AboutNumbers about={slice?.about} />
}

