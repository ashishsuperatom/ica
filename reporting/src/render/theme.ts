// ── Themes ───────────────────────────────────────────────────────────────────
// A theme is a set of TOKENS plus a CHROME mode. Nothing in the renderer hard-codes
// a colour or a border, so a new look is a value set — never a new template, and
// never a second copy of the markup.
//
// `chrome` matters as much as the colours. The product's two looks differ
// structurally, not just chromatically:
//
//   'rule' — blocks separated by RULES. A heavy 1.5px ink line above the figures
//            and under each table header, hairlines between rows. No boxes. This is
//            the live answer card (control-plane/user-ui ANSWER_CSS).
//   'card' — blocks in rounded surfaces with borders, on a tinted page. This is the
//            older design-system look (user-ui/public/design.css).
//
// Both are produced from the SAME markup (html.ts). The stylesheet decides whether
// `.sa-card` is a box or is invisible — which is exactly why adding a theme can
// never fork the renderer.
//
// Two constraints from the surfaces, not from taste:
//  • Tokens are substituted as LITERAL values, not `var()`. Outlook is unreliable
//    with custom properties.
//  • Every px is multiplied by `scale`. A PNG has no devicePixelRatio — Takumi's
//    raster is exactly its layout size — so a crisp 2× image is made by laying the
//    document out at twice the size.
//
// Artefacts are light-only: a baked image cannot respond to a viewer's theme.

export interface Theme {
  name: string
  chrome: 'rule' | 'card'
  page: string          // the surface a report is printed on
  panel: string         // subtle fill: caveats, header bands, total rows
  rule: string          // structural lines (card borders, heavy rules)
  hair: string          // hairlines between rows
  ink: string           // strongest: headings, numbers, bold
  body: string          // body copy
  muted: string         // labels, captions, counts
  accent: string        // the brand colour — category label, pills, links
  negative: string      // a figure that is bad news
  positive?: string     // a figure that is good news; omitted = the theme doesn't
                        // colour good news at all (the editorial choice)
  font: string
  radius: number
  logoUrl?: string
  wordmark?: string
}

/** The live answer card, token for token (control-plane/user-ui/src/App.tsx
 *  ANSWER_CSS). This is what the product looks like today, so it is the default. */
export const EDITORIAL: Theme = {
  name: 'editorial',
  chrome: 'rule',
  page: '#ffffff',
  panel: '#f6f7f9',
  rule: '#c9ccd1',
  hair: '#e2e4e8',
  ink: '#161719',
  body: '#33373c',
  muted: '#6c7075',
  accent: '#15385c',
  negative: '#8a5a12',   // amber, not red — the live card reserves red for errors
  font: "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif",
  radius: 3,
  wordmark: 'Superatom',
}

/** The design-system look: warm paper, orange accent, rounded cards
 *  (user-ui/public/design.css). */
export const PAPER: Theme = {
  name: 'paper',
  chrome: 'card',
  page: '#f5f3ef',
  panel: '#faf9f7',
  rule: '#e8e4de',
  hair: '#f0ede8',
  ink: '#1a1a1a',
  body: '#33302c',
  muted: '#9a9285',
  accent: '#e55a1f',
  negative: '#b91c1c',
  positive: '#059669',
  font: "'Inter', system-ui, sans-serif",
  radius: 12,
  wordmark: 'Superatom',
}

export const THEMES: Record<string, Theme> = { editorial: EDITORIAL, paper: PAPER }
export const DEFAULT_THEME = EDITORIAL

export function resolveTheme(t?: string | Partial<Theme> | null): Theme {
  if (!t) return DEFAULT_THEME
  if (typeof t === 'string') return THEMES[t] ?? DEFAULT_THEME
  const base = typeof t.name === 'string' && THEMES[t.name] ? THEMES[t.name] : DEFAULT_THEME
  return { ...base, ...t }
}

export function stylesheet(t: Theme, scale = 1): string {
  const p = (n: number) => `${+(n * scale).toFixed(2)}px`
  const card = t.chrome === 'card'

  // Chrome-dependent rules. Everything else below is shared.
  const chrome = card ? `
.sa-card { background: #ffffff; border: ${p(1)} solid ${t.rule}; border-radius: ${p(t.radius)};
  margin-bottom: ${p(16)}; }
.sa-card-pad { padding: ${p(20)} ${p(24)}; }
.sa-stats { }
.sa-stat { padding: ${p(4)} ${p(20)}; border-left: ${p(1)} solid ${t.hair}; }
.sa-stat.first { border-left: none; padding-left: 0; }
.sa-table th { background: ${t.panel}; border-bottom: ${p(1)} solid ${t.hair}; padding: ${p(9)} ${p(16)}; }
.sa-table td { padding: ${p(10)} ${p(16)}; }
.sa-table tr.total td { background: ${t.panel}; border-bottom: none; }
.sa-sec-title { color: ${t.muted}; }
.sa-spill { background: ${t.panel}; border-top: ${p(1)} solid ${t.hair}; padding: ${p(11)} ${p(16)}; }
.sa-note { padding: ${p(9)} ${p(16)} ${p(2)} ${p(16)}; }
` : `
/* No boxes: blocks are separated by rules, and .sa-card is structurally inert. */
.sa-card { background: transparent; border: none; margin-bottom: ${p(18)}; }
.sa-card-pad { padding: 0; }
/* The heavy ink rule above the figures and the lighter one below are the whole
   frame — this is the live card's signature. */
.sa-stats { border-top: ${p(1.5)} solid ${t.ink}; border-bottom: ${p(1)} solid ${t.rule}; }
.sa-stat { padding: ${p(12)} ${p(16)} ${p(13)} ${p(16)}; border-left: ${p(1)} solid ${t.hair}; }
.sa-stat.first { border-left: none; padding-left: 0; }
.sa-table th { background: transparent; border-bottom: ${p(1.5)} solid ${t.ink};
  padding: 0 ${p(18)} ${p(8)} ${p(18)}; }
.sa-table td { padding: ${p(9)} ${p(18)}; }
.sa-table th.first, .sa-table td.first { padding-left: 0; }
.sa-table th.last, .sa-table td.last { padding-right: 0; }
.sa-table tr.total td { border-top: ${p(1.5)} solid ${t.ink}; border-bottom: none; color: ${t.ink}; }
.sa-sec-title { color: ${t.ink}; border-bottom: ${p(1)} solid ${t.ink};
  padding-bottom: ${p(6)}; font-weight: 800; }
.sa-table td.first { color: ${t.ink}; }
.sa-spill { padding: ${p(10)} 0 0 0; }
.sa-note { padding: ${p(8)} 0 0 0; }
`

  return `
html, body { margin: 0; padding: 0; background: ${t.page}; }
.sa-report { background: ${t.page}; color: ${t.body}; font-family: ${t.font};
  font-size: ${p(14)}; line-height: 1.6; padding: ${p(26)} ${p(28)}; }
/* Lining tabular figures: digits share one advance width, so columns of numbers line
   up on the decimal without any alignment trickery. */
.sa-table, .sa-num, .sa-stats { font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1; }

/* A masthead rule: the report announces itself as a document rather than starting
   mid-air. Cheap, and it does most of the work of making the page feel deliberate. */
.sa-masthead { border-top: ${p(3)} solid ${t.ink}; margin-bottom: ${p(12)}; }
.sa-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: ${p(10)}; }
.sa-brand { display: flex; align-items: center; color: ${t.accent}; font-weight: 800;
  font-size: ${p(11)}; letter-spacing: ${p(1.3)}; text-transform: uppercase; }
.sa-logo { height: ${p(18)}; margin-right: ${p(8)}; }
.sa-cat { color: ${t.accent}; font-size: ${p(10)}; font-weight: 800;
  letter-spacing: ${p(1.4)}; text-transform: uppercase; }

.sa-title { font-size: ${p(23)}; font-weight: 700; line-height: 1.26; letter-spacing: ${p(-0.45)};
  margin: 0 0 ${p(9)} 0; color: ${t.ink}; }

/* The period reads as a labelled fact, not a caption — the accent pill is the live
   card's "TIME FILTER" treatment. A flex row, as the live card does it: the pill is
   a non-shrinking item so it is sized by its own text. As an inline-block it got
   clipped — the box was sized before white-space applied and the background was cut
   mid-word. (No backticks in this file's comments: the stylesheet is a template
   literal, and one would end it.) */
.sa-period { display: flex; align-items: baseline; flex-wrap: wrap;
  font-size: ${p(11)}; color: ${t.body}; margin-bottom: ${p(16)}; }
.sa-period .pv { flex-shrink: 1; }
.sa-period .pk { flex-grow: 0; flex-shrink: 0; font-size: ${p(9.5)}; letter-spacing: ${p(0.9)};
  text-transform: uppercase; font-weight: 800; color: ${t.page}; background: ${t.accent};
  padding: ${p(2)} ${p(7)}; margin-right: ${p(9)}; white-space: nowrap; }
.sa-period b { color: ${t.ink}; font-weight: 700; }

.sa-prose { font-size: ${p(15)}; line-height: 1.62; color: ${t.body}; }
.sa-prose p { margin: 0 0 ${p(10)} 0; }
.sa-prose p:last-child { margin-bottom: 0; }
.sa-prose b { color: ${t.ink}; font-weight: 700; }

/* Figures: a grid so every tile shares the row evenly and a long label can't shove
   its neighbours around (the live card uses auto-fit/minmax for the same reason). */
.sa-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(${p(115)}, 1fr)); }
.sa-stat-label { color: ${t.muted}; font-size: ${p(10)}; font-weight: 700;
  letter-spacing: ${p(0.6)}; text-transform: uppercase; }
.sa-num { font-size: ${p(26)}; font-weight: 700; line-height: 1.12; letter-spacing: ${p(-0.5)};
  color: ${t.ink}; margin-top: ${p(6)}; }
.sa-num.negative { color: ${t.negative}; }
.sa-num.positive { color: ${t.positive ?? t.ink}; }
.sa-stat-sub { color: ${t.muted}; font-size: ${p(11.5)}; margin-top: ${p(2)}; }

.sa-sec-title { font-size: ${p(12)}; font-weight: 700; letter-spacing: ${p(0.5)};
  text-transform: uppercase; margin: 0 0 ${p(10)} 0; }

.sa-table { width: 100%; border-collapse: collapse; font-size: ${p(13.5)}; }
.sa-table th { text-align: left; font-size: ${p(10.5)}; font-weight: 700;
  letter-spacing: ${p(0.5)}; text-transform: uppercase; color: ${t.body}; }
.sa-table td { border-bottom: ${p(1)} solid ${t.hair}; color: ${t.body}; }
.sa-table th.num, .sa-table td.num { text-align: right; }
/* A figure column is the point of the row, so it carries the ink weight. */
.sa-table td.num { color: ${t.ink}; font-weight: 700; }
.sa-table tr.total td { font-weight: 700; color: ${t.ink}; }

/* Magnitude bar under a value: descriptive only — it encodes how big this row is
   relative to the largest, and says nothing about whether big is good. */
.sa-barwrap { display: flex; justify-content: flex-end; margin-top: ${p(4)}; }
.sa-bar { display: block; height: ${p(2.5)}; background: ${t.accent}; opacity: 0.32; }

.sa-spill { color: ${t.accent}; font-size: ${p(10.5)}; font-weight: 700;
  letter-spacing: ${p(0.5)}; text-transform: uppercase; }
.sa-note { color: ${t.muted}; font-size: ${p(10.5)}; font-weight: 700;
  letter-spacing: ${p(0.5)}; text-transform: uppercase; }

.sa-caveat { font-size: ${p(12.5)}; line-height: 1.6; color: ${t.body}; background: ${t.panel};
  border: ${p(1)} solid ${t.hair}; border-radius: ${p(Math.min(t.radius, 6))};
  padding: ${p(8)} ${p(12)}; margin: 0 0 ${p(12)} 0; }

.sa-foot { display: flex; align-items: center; justify-content: space-between;
  border-top: ${p(1)} solid ${t.hair}; padding-top: ${p(9)}; margin-top: ${p(4)};
  color: ${t.muted}; font-size: ${p(11)}; }
.sa-foot .link { color: ${t.accent}; font-weight: 700; }
${chrome}`.trim()
}
