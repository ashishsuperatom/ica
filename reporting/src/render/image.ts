// ── HTML → PNG, no browser ───────────────────────────────────────────────────
// Takumi (@takumi-rs/wasm) is a Rust HTML/CSS layout+raster engine compiled to
// WebAssembly, with a Cloudflare Workers entry point. It parses our HTML, applies
// the <style> block through a real CSS cascade (Servo's Stylo), lays out, and
// rasterises — all inside the Worker, ~1.5MB gzipped, no headless browser.
//
// What it supports that Satori does not: grid, block/inline/float, real selectors,
// pseudo-elements. What NOTHING in this class supports: JavaScript, animation,
// viewport media queries, pixel-exact Chrome parity. We author within that, which
// is easy because we own the markup.
//
// Height is intentionally left unset — Takumi measures the content and grows the
// image to fit. The fit heuristics (fit.ts), not a hard crop, are what keep an
// image a sane size, because a crop would hide data and a squeeze would lie.

import { fromHtml } from '@takumi-rs/helpers/html'
import type { Answer } from '../types.js'
import { DEFAULT_LIMITS, fitAnswer, type FitLimits, type FitReport } from './fit.js'
import { renderDocument, type RenderHtmlOptions } from './html.js'
import { resolveTheme, type Theme } from './theme.js'

export interface ImageOptions {
  theme?: string | Partial<Theme> | null
  limits?: Partial<FitLimits>
  scale?: number           // device pixel ratio; 2 for crisp display in chat/mail
  title?: string
  footerLeft?: string
  footerRight?: string
  format?: 'png' | 'webp' | 'jpeg'
}

export interface ImageResult {
  bytes: Uint8Array
  contentType: string
  width: number
  fit: FitReport
  html: string             // the exact HTML rasterised — kept for debugging drift
}

/** A Takumi renderer, minus the wasm-init and font-loading details, which differ
 *  between the Worker (wasm import + R2/KV fonts) and local test runs. Callers
 *  supply a ready renderer so this module stays environment-agnostic. */
export interface Rasteriser {
  render(node: unknown, options: Record<string, unknown>): Promise<Uint8Array>
  /** Optional. When present, the height budget is enforced by measuring the laid-out
   *  document and cutting rows until it fits — far more accurate than guessing from
   *  row counts, because prose length and wrapped cells dominate the real height. */
  measure?(node: unknown, options: Record<string, unknown>): Promise<{ height: number }>
}

/** Render an Answer to image bytes. Pure: no storage, no network, no knowledge of
 *  who asked or what they'll do with it. */
export async function renderImage(a: Answer, r: Rasteriser, o: ImageOptions = {}): Promise<ImageResult> {
  const theme = resolveTheme(o.theme)
  let limits: FitLimits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) }
  const scale = o.scale ?? 2
  const format = o.format ?? 'png'

  // Reduce FIRST, render second — so the announcement of what was dropped is part
  // of the same document that gets rasterised.
  //
  // Row limits alone can't hit a height budget: a report's height is driven as much
  // by prose, wrapped cells and section count as by row count. So when the rasteriser
  // can measure, we lay out, check the height, and cut rows until it fits — at most a
  // few cheap iterations, converging downward and never re-ordering anything.
  const build = (lim: FitLimits) => {
    const f = fitAnswer(a, lim)
    const opts: RenderHtmlOptions = {
      theme, scale, surface: 'image', title: o.title,
      footerLeft: o.footerLeft, footerRight: o.footerRight,
      fitNotes: f.fit.notes,
    }
    return { fitted: f, html: renderDocument(f.answer, opts) }
  }

  let { fitted, html } = build(limits)
  if (r.measure) {
    const frame = Math.round(limits.width * scale)
    for (let i = 0; i < 4; i++) {
      const probe = fromHtml(html)
      const m = await r.measure(probe.node, { width: frame, stylesheets: probe.stylesheets })
      if ((m?.height ?? 0) <= limits.maxHeight * scale) break
      // Cut roughly the overflow's worth of rows, with a floor: a table below ~4 rows
      // stops being a table, and at that point the image simply is what it is — the
      // spill line tells the reader to open the full report.
      const rowsNow = limits.maxRows
      const over = (m.height / scale) - limits.maxHeight
      const next = Math.max(4, rowsNow - Math.max(1, Math.ceil(over / 34)))
      if (next >= rowsNow) break
      limits = { ...limits, maxRows: next }
      ;({ fitted, html } = build(limits))
    }
  }

  // A PNG has no devicePixelRatio — Takumi's output is exactly its layout size, so
  // `devicePixelRatio` does NOT enlarge the raster (verified: it changes nothing).
  // Crispness therefore comes from laying the WHOLE document out at `scale`× — the
  // stylesheet's px values are pre-multiplied (theme.ts) and the frame matches.
  const { node, stylesheets } = fromHtml(html)
  const bytes = await r.render(node, {
    width: Math.round(limits.width * scale),
    stylesheets,
    format,
  })

  return {
    bytes,
    contentType: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
    width: Math.round(limits.width * scale),
    fit: fitted.fit,
    html,
  }
}
