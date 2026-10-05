// The project's own views, in a session: the slice holds the question the project's application understands (what it
// looks at, its filters, its breakdown, its window); run asks the application for exactly that question, move applies
// the application's next moves to it. The views' logic stays where it is (the project's application, on its domains'
// programs): nothing is copied here. Each answer's blocks are drawn by the platform's answer component.

type Ctx = { set(patch: Record<string, unknown>): void; params: Record<string, unknown>; services: { app(payload: Record<string, unknown>): Promise<any> } }
type Slice = { question: Record<string, unknown> | null; title: string; next: unknown[]; about?: Record<string, unknown> | null }

function show(reply: any, ctx: Ctx) {
  if (reply?.t === 'app:refused') return { answer: { markdown: String(reply.reason ?? 'The application refused that.') } }
  if (reply?.t !== 'app:answer') return { answer: { markdown: `The application did not answer: ${reply?.error ?? reply?.reason ?? reply?.t ?? 'nothing came back'}` } }
  const a = reply.answer ?? reply   // the answer's fields come on the reply itself
  // What the view's controls and its footer need: the question (filters, breakdown, window), the next moves, and what
  // the numbers stand on (the window and span used, settings, assumptions, the reads, the notes, the time it took).
  // The values each column of the answer's tables takes (an attribute filter offers them).
  const seen: Record<string, string[]> = {}
  for (const b of a.blocks ?? []) if (b?.type === 'table') for (const r of b.rows ?? []) for (const [k, v] of Object.entries(r ?? {})) {
    if (typeof v !== 'string' || !v.trim()) continue
    const list = (seen[k] ??= [])
    if (list.length < 100 && !list.includes(v)) list.push(v)
  }
  const about = { seen, used: a.used ?? null, notes: Array.isArray(a.notes) ? a.notes : [], asked: Array.isArray(a.asked) ? a.asked : [], ms: Number(a.ms ?? 0), today: String(a.today ?? ''), dropped: Array.isArray(a.dropped) ? a.dropped : [] }
  ctx.set({ question: a.question ?? null, title: String(a.title ?? ''), next: Array.isArray(a.next) ? a.next : [], about })
  const blocks: Record<string, unknown> = {}
  const markers: string[] = []
  ;(a.blocks ?? []).forEach((b: any, i: number) => { const name = `b${i}`; blocks[name] = b; markers.push(`:::${b?.type ?? 'text'} ${name}`) })
  // The first line names the step (its title, and what was done); the question itself shows in the view's controls.
  const lead = [a.title ? `**${a.title}**` : '', a.said ? `_${a.said}_` : ''].filter(Boolean).join(' — ')
  return { answer: { markdown: [lead, ...markers].filter(Boolean).join('\n'), blocks } }
}

export async function run(state: { view: Slice }, ctx: Ctx) {
  const q = state.view.question
  if (!q) return { answer: { markdown: 'Nothing to look at yet.' } }
  // A view named only by what it looks at (an agent's start) opens as the application opens it, with its defaults (its
  // window); a full question is asked as it is.
  const opening = !('window' in q) && !('by' in q) && !('pages' in q)
  return show(await ctx.services.app(opening ? { t: 'app:start', focus: q.focus, where: q.where ?? [] } : { t: 'app:ask', question: q }), ctx)
}

/** A row clicked in one of the view's blocks: the block's row move (the dimension, the row's key and label, a view to
 *  open), as the application's ops — then applied like any next move. */
export async function row(state: { view: Slice }, ctx: Ctx) {
  const move = (ctx.params.move ?? {}) as { dim?: string; key?: string; label?: string; focus?: string; also?: { dim: string; key: string; label: string }[] }
  const r = (ctx.params.row ?? {}) as Record<string, unknown>
  const value = move.key ? r[move.key] : undefined
  if (!move.dim || value === null || value === undefined || value === '') return run(state, ctx)
  const label = typeof r[move.label ?? ''] === 'string' ? String(r[move.label!]) : String(value)
  const more = (move.also ?? []).flatMap((a) => { const v = r[a.key]; return v === null || v === undefined || v === '' ? [] : [{ op: 'push', dim: a.dim, value: String(v), label: typeof r[a.label] === 'string' ? String(r[a.label]) : String(v) }] })
  const ops = [...(move.focus ? [{ op: 'focus', on: move.focus }] : []), { op: 'push', dim: move.dim, value: String(value), label }, ...more]
  return move_(state, ctx, ops)
}

/** One of the application's next moves (its ops on the question), applied. */
export async function move(state: { view: Slice }, ctx: Ctx) {
  return move_(state, ctx, Array.isArray(ctx.params.ops) ? ctx.params.ops : [])
}

async function move_(state: { view: Slice }, ctx: Ctx, ops: unknown[]) {
  if (!state.view.question || !ops.length) return run(state, ctx)
  return show(await ctx.services.app({ t: 'app:move', question: state.view.question, ops }), ctx)
}
