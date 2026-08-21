// ── Fonts, bundled into the Worker ───────────────────────────────────────────
// Inter 400/600/700 as `Data` modules (see wrangler.toml `rules`), so they arrive
// as ArrayBuffers with no fetch at request time.
//
// ~960KB total. That is fine bundled, but it is the first thing to move to R2 if
// we add scripts (CJK alone would dwarf this) — Takumi's FontLoader takes a lazy
// `data()` with codepoint ranges precisely so faces can be fetched only when a
// report actually contains characters they cover.
//
// Registration is per-ISOLATE, not per-render: doing it inside the request path
// would re-parse a megabyte of font on every hit.

import inter400 from '../assets/fonts/Inter-400.ttf'
import inter600 from '../assets/fonts/Inter-600.ttf'
import inter700 from '../assets/fonts/Inter-700.ttf'

// `generic: 'sans-serif'` is what makes a theme's font STACK resolve. The editorial
// theme asks for "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif — none of
// which we ship — so without a generic binding every glyph would fall back to tofu.
// Registering Inter as the sans-serif generic means any stack ending in sans-serif
// lands here, which is also what the web app effectively renders.
export const INTER = [
  { name: 'Inter', data: inter400, weight: 400, style: 'normal' as const, generic: 'sans-serif' as const },
  { name: 'Inter', data: inter600, weight: 600, style: 'normal' as const, generic: 'sans-serif' as const },
  { name: 'Inter', data: inter700, weight: 700, style: 'normal' as const, generic: 'sans-serif' as const },
]
