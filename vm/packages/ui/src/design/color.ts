// The colour half of the design system, for code. The values live in ./tokens.css as CSS variables; this file names
// what each one means, so a component asks for a meaning ("a loss", "the second series") rather than a colour, and
// TypeScript refuses a meaning that does not exist.
//
// The rule: a colour says what a number means, never decoration. Amber always means "act on this"; green only ever
// means something went well; the primary colour is for what can be done, not for data.

/** What a figure is about: the accent a KPI, a bar, a badge, a slice or a total carries. */
export const MEANING = {
  'series-1': { token: 'var(--series-1)', means: 'The first series: what is, as it stands' },
  'series-2': { token: 'var(--series-2)', means: 'The second series: what is planned, compared, forked' },
  'series-3': { token: 'var(--series-3)', means: 'A third series' },
  loss: { token: 'var(--loss)', means: 'Red · critical · under · failed' },
  warn: { token: 'var(--warn)', means: 'Amber · warning · over · act on this' },
  win: { token: 'var(--win)', means: 'Green · ok · on target · something went well' },
  neutral: { token: 'var(--neutral)', means: 'No particular meaning: secondary, neutral' },
} as const

export type Accent = keyof typeof MEANING

/** The CSS colour for each meaning, for inline styles. */
export const ACCENT = Object.fromEntries(Object.entries(MEANING).map(([k, v]) => [k, v.token])) as { [K in Accent]: (typeof MEANING)[K]['token'] }

/** The state a figure carries, as its meaning. */
export const STATE_ACCENT = { ok: 'win', warning: 'warn', critical: 'loss' } as const satisfies Record<string, Accent>

/** A RAG word as its meaning, or nothing when the word is not one. */
export const ragAccent = (word: string): Accent | undefined => (/^red$/i.test(word) ? 'loss' : /^amber$/i.test(word) ? 'warn' : /^green$/i.test(word) ? 'win' : undefined)

/**
 * A meaning mixed toward the surface: `tint('warn', 10)` for a fill behind amber text, `tint('series-1', 35)` for a
 * paler neighbour of the same meaning. The meaning never changes, only its strength.
 */
export const tint = (meaning: Accent, percent: number) => `color-mix(in srgb, ${ACCENT[meaning]} ${percent}%, var(--surface))`

/*
 * Charts paint on a canvas, and a canvas cannot read CSS: `var(--series-1)` and `color-mix(...)` mean nothing to it,
 * and a slice handed one is drawn black. These resolve a token to a real value for anything that is not CSS. Read
 * them at render, never at import: the stylesheet may not be there yet when a module loads.
 */

/** A token's value as the page has it: `read('--t-sm')` → "12px". Empty off the DOM (a test). */
export const read = (name: string) => (typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim())

/** A colour token as a colour a chart can draw: `paint('warn')` → "#f59e0b". Off the DOM it falls back to grey. */
export const paint = (token: Accent | 'ink' | 'muted' | 'faint' | 'line' | 'surface' | 'panel') => read(`--${token}`) || '#94a3b8'

/**
 * The colours a set of categories takes, in the order they are handed out: eight hues well apart, then the same
 * eight darker. Neighbours contrast, which is what matters when slices of a ring sit side by side. Every one reads
 * at 4.4:1 or better against white, because the same colour is a badge's text at 11px. Real colours, not variables:
 * these are drawn on canvases as well as in CSS.
 */
export const ACTION_PALETTE = [
  '#4C78A8', '#B0642F', '#46814A', '#8E6BA8', '#37807A', '#B25A5A', '#7A6A55', '#6B7280',
  '#305F8A', '#8A4B1E', '#2E6638', '#6A4A86', '#2A625E', '#8C3F3F', '#5C5042', '#4B5563',
]

/** Hand the palette out across a list of keys, in order; a key keeps its colour when the list is reordered. */
export const coloursFor = (keys: string[]) => {
  const of = new Map([...keys].sort().map((k, i) => [k, ACTION_PALETTE[i % ACTION_PALETTE.length]]))
  return (key: string): string | undefined => of.get(key)
}
