// ── Themes ───────────────────────────────────────────────────────────────────
// A theme is a small set of TOKENS. Everything the renderer draws refers to a
// token, never a literal, so a new look is a row of values rather than a new
// template. The token names deliberately mirror the web app's `--sa-*` custom
// properties (cloudflare/user-ui/public/design.css), because the whole point of
// this service is that a report looks like the product, not like a bot.
//
// Two things differ from the web stylesheet, both forced by the surfaces:
//
//  • Tokens are substituted as LITERAL values, not emitted as `var()`. Outlook is
//    unreliable with custom properties, and it keeps the image renderer's CSS
//    engine on a well-worn path. Cost: a per-project stylesheet of a few KB.
//  • Every px is multiplied by `scale`. A PNG has no devicePixelRatio — the
//    renderer's output is exactly its layout size — so a crisp 2× image is made by
//    laying the whole document out at twice the size, not by scaling a raster.
//
// Artefacts are LIGHT-ONLY. Email and chat are light surfaces in practice, and a
// baked image cannot respond to a viewer's theme anyway.

export interface Theme {
  name: string
  bg: string            // page/paper behind the cards
  surface: string       // card background
  surfaceAlt: string    // table header band, subtle fills
  border: string        // card borders
  borderSoft: string    // table rules, stat dividers
  text: string
  textMuted: string
  textFaint: string     // labels, captions
  accent: string        // the brand colour
  positive: string
  negative: string
  font: string
  radius: number
  logoUrl?: string
  wordmark?: string
}

/** Matches the web app's design tokens 1:1 — a report should read as the same
 *  product as the React UI. This is the default and, for now, the one we ship. */
export const SUPERATOM: Theme = {
  name: 'superatom',
  bg: '#f5f3ef',
  surface: '#ffffff',
  surfaceAlt: '#faf9f7',
  border: '#e8e4de',
  borderSoft: '#f0ede8',
  text: '#1a1a1a',
  textMuted: '#6b6560',
  textFaint: '#9a9285',
  accent: '#e55a1f',
  positive: '#059669',
  negative: '#b91c1c',
  font: "'Inter', system-ui, sans-serif",
  radius: 12,
  wordmark: 'Superatom',
}

/** A second theme, cooler and flatter, kept mainly to prove the token layer is real
 *  — if a theme is only a value set, adding one costs nothing and nothing in the
 *  renderer may hard-code a colour. */
export const SLATE: Theme = {
  name: 'slate',
  bg: '#f6f7f9',
  surface: '#ffffff',
  surfaceAlt: '#f9fafb',
  border: '#e3e6ea',
  borderSoft: '#eef0f3',
  text: '#111827',
  textMuted: '#5b6472',
  textFaint: '#98a1af',
  accent: '#2f6fd0',
  positive: '#047857',
  negative: '#be123c',
  font: "'Inter', system-ui, sans-serif",
  radius: 8,
  wordmark: 'Superatom',
}

export const THEMES: Record<string, Theme> = { superatom: SUPERATOM, slate: SLATE }
export const DEFAULT_THEME = SUPERATOM

export function resolveTheme(t?: string | Partial<Theme> | null): Theme {
  if (!t) return DEFAULT_THEME
  if (typeof t === 'string') return THEMES[t] ?? DEFAULT_THEME
  const base = typeof t.name === 'string' && THEMES[t.name] ? THEMES[t.name] : DEFAULT_THEME
  return { ...base, ...t }
}

/** The report stylesheet with the theme baked in and every dimension multiplied by
 *  `scale`. Restricted to primitives that survive BOTH a WASM CSS engine and
 *  Outlook: block/inline, flex, tables. No grid, no var(), no @media, no shadows
 *  that matter (they degrade silently). */
export function stylesheet(t: Theme, scale = 1): string {
  const p = (n: number) => `${+(n * scale).toFixed(2)}px`
  return `
html, body { margin: 0; padding: 0; background: ${t.bg}; }
.sa-report { background: ${t.bg}; color: ${t.text}; font-family: ${t.font};
  font-size: ${p(15)}; line-height: 1.5; padding: ${p(28)} ${p(30)}; }

.sa-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: ${p(18)}; }
.sa-brand { display: flex; align-items: center; color: ${t.accent}; font-weight: 700;
  font-size: ${p(14)}; letter-spacing: ${p(0.2)}; }
.sa-logo { height: ${p(20)}; margin-right: ${p(8)}; }
.sa-cat { color: ${t.textFaint}; font-size: ${p(11)}; font-weight: 600;
  letter-spacing: ${p(0.9)}; text-transform: uppercase; }

.sa-title { font-size: ${p(24)}; font-weight: 700; line-height: 1.28; letter-spacing: ${p(-0.4)};
  margin: 0 0 ${p(6)} 0; color: ${t.text}; }
.sa-scope { color: ${t.textMuted}; font-size: ${p(13)}; margin-bottom: ${p(20)}; }

/* Cards — the web app's .sa-card shell. */
.sa-card { background: ${t.surface}; border: ${p(1)} solid ${t.border};
  border-radius: ${p(t.radius)}; margin-bottom: ${p(16)}; }
.sa-card-pad { padding: ${p(20)} ${p(24)}; }

.sa-prose { font-size: ${p(15.5)}; line-height: 1.6; color: ${t.text}; }
.sa-prose p { margin: 0 0 ${p(10)} 0; }
.sa-prose p:last-child { margin-bottom: 0; }

/* Stats — flex row, each tile sized to its number, divided by a left rule, exactly
   like .sa-stats/.sa-stat in the web design system. */
.sa-stats { display: flex; flex-wrap: wrap; }
.sa-stat { flex-grow: 1; flex-shrink: 1; flex-basis: ${p(110)};
  padding: ${p(4)} ${p(20)}; border-left: ${p(1)} solid ${t.borderSoft}; }
.sa-stat.first { border-left: none; padding-left: 0; }
.sa-stat-label { color: ${t.textFaint}; font-size: ${p(11)}; font-weight: 600;
  letter-spacing: ${p(0.9)}; text-transform: uppercase; margin-bottom: ${p(7)}; }
.sa-num { font-size: ${p(28)}; font-weight: 700; line-height: 1.1;
  letter-spacing: ${p(-0.6)}; color: ${t.text}; }
.sa-num.positive { color: ${t.positive}; }
.sa-num.negative { color: ${t.negative}; }
.sa-stat-sub { color: ${t.textMuted}; font-size: ${p(12)}; margin-top: ${p(5)}; }

.sa-sec-title { font-size: ${p(11)}; font-weight: 600; letter-spacing: ${p(0.9)};
  text-transform: uppercase; color: ${t.textFaint}; margin: 0 0 ${p(12)} 0; }

/* Table — header band + hairline rules, matching .sa-table. */
.sa-table { width: 100%; border-collapse: collapse; font-size: ${p(13)}; }
.sa-table th { padding: ${p(9)} ${p(16)}; text-align: left; font-size: ${p(11)}; font-weight: 600;
  letter-spacing: ${p(0.5)}; color: ${t.textFaint}; background: ${t.surfaceAlt};
  border-bottom: ${p(1)} solid ${t.borderSoft}; }
.sa-table td { padding: ${p(10)} ${p(16)}; border-bottom: ${p(1)} solid ${t.borderSoft};
  color: ${t.text}; line-height: 1.4; }
.sa-table th.num, .sa-table td.num { text-align: right; }
.sa-table tr.total td { font-weight: 700; background: ${t.surfaceAlt}; border-bottom: none; }

.sa-spill { color: ${t.accent}; font-size: ${p(12)}; font-weight: 600; letter-spacing: ${p(0.2)};
  padding: ${p(11)} ${p(16)}; background: ${t.surfaceAlt}; border-top: ${p(1)} solid ${t.borderSoft}; }
.sa-note { color: ${t.textFaint}; font-size: ${p(12)}; padding: ${p(9)} ${p(16)} ${p(2)} ${p(16)}; }

.sa-caveat { color: ${t.textMuted}; font-size: ${p(12.5)}; line-height: 1.5;
  border-left: ${p(3)} solid ${t.border}; padding-left: ${p(12)}; margin: 0 0 ${p(16)} 0; }

.sa-foot { display: flex; align-items: center; justify-content: space-between;
  border-top: ${p(1)} solid ${t.border}; padding-top: ${p(12)}; margin-top: ${p(4)};
  color: ${t.textFaint}; font-size: ${p(11.5)}; }
.sa-foot .link { color: ${t.accent}; font-weight: 600; }
`.trim()
}
