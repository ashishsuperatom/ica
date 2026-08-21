// ── superatom-reporting ──────────────────────────────────────────────────────
// v0: STATELESS. An Answer goes in, a report comes out — as HTML or as a PNG.
// No storage, no ids, no signed links yet. The point of this stage is to prove the
// browser-free render works inside workerd (wasm instantiation, font registration
// and layout all inside a Worker's CPU budget) before any storage is built on top.
//
//   GET  /                    this index
//   GET  /sample              the sample report as HTML
//   GET  /sample.png          the sample report as a PNG            ← the real check
//   POST /render              { answer, ...opts } → image/png
//   POST /preview             { answer, ...opts } → text/html
//
// Deliberately not here yet: report ids, R2 persistence, signed URLs, TTLs, CSV,
// the email inliner. See README.

import { renderImage, type ImageOptions } from './render/image.js'
import { renderDocument } from './render/html.js'
import { resolveTheme } from './render/theme.js'
import { DEFAULT_LIMITS } from './render/fit.js'
import { renderer } from './renderer.js'
import { sampleAnswer } from './sample.js'
import type { Answer } from './types.js'

interface Body extends ImageOptions { answer?: Answer }

const html = (b: string, status = 200) =>
  new Response(b, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { 'content-type': 'application/json' } })

/** Options shared by both surfaces, so /preview and /render can't disagree. */
function opts(b: Body, title?: string): ImageOptions & { title?: string } {
  return {
    theme: b.theme, limits: b.limits, scale: b.scale, format: b.format,
    title: b.title ?? title,
    footerLeft: b.footerLeft, footerRight: b.footerRight,
  }
}

async function png(a: Answer, o: ImageOptions): Promise<Response> {
  const t0 = Date.now()
  const out = await renderImage(a, await renderer(), o)
  return new Response(out.bytes as BodyInit, {
    headers: {
      'content-type': out.contentType,
      'cache-control': 'no-store',              // v0 is stateless; nothing to cache yet
      // Surfaced as headers so the render can be inspected without a second call —
      // how long it took, and exactly what the fit pass dropped.
      'x-render-ms': String(Date.now() - t0),
      'x-render-width': String(out.width),
      'x-fit-reduced': String(out.fit.reduced),
      'x-fit-dropped': `rows=${out.fit.droppedRows} cols=${out.fit.droppedCols} figures=${out.fit.droppedFigures} sections=${out.fit.droppedSections}`,
    },
  })
}

function previewHtml(a: Answer, o: ImageOptions & { title?: string }): Response {
  const theme = resolveTheme(o.theme)
  const limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) }
  // The HTML surface is COMPLETE — no fit pass, every row and column — which is the
  // whole reason an image links back to it.
  return html(renderDocument(a, {
    theme, scale: 1, title: o.title,
    footerLeft: o.footerLeft, footerRight: o.footerRight,
  }))
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      if (request.method === 'GET' && path === '/sample.png') {
        return await png(sampleAnswer, {
          ...opts({}, SAMPLE_TITLE),
          scale: Number(url.searchParams.get('scale') ?? 2),
          theme: url.searchParams.get('theme') ?? undefined,
          footerLeft: SAMPLE_FOOTER,
          footerRight: 'View the full report',
          limits: url.searchParams.get('rows') ? { maxRows: Number(url.searchParams.get('rows')) } : undefined,
        })
      }

      if (request.method === 'GET' && path === '/sample') {
        return previewHtml(sampleAnswer, {
          title: SAMPLE_TITLE, footerLeft: SAMPLE_FOOTER,
          theme: url.searchParams.get('theme') ?? undefined,
        })
      }

      if (request.method === 'POST' && (path === '/render' || path === '/preview')) {
        const body = await request.json().catch(() => null) as Body | null
        if (!body?.answer) return json({ ok: false, error: 'body must be { answer: Answer, ... }' }, 400)
        return path === '/render'
          ? await png(body.answer, opts(body))
          : previewHtml(body.answer, opts(body))
      }

      if (request.method === 'GET' && path === '/') return html(INDEX)
      return json({ ok: false, error: 'not found' }, 404)
    } catch (e: unknown) {
      // Render failures are reported, never swallowed into a blank image — a broken
      // report must look broken, not empty.
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
      console.log('[reporting] render failed:', msg)
      return json({ ok: false, error: msg }, 500)
    }
  },
}

const SAMPLE_TITLE = 'Which branches make money, and which are dragging the network down?'
const SAMPLE_FOOTER = 'Sample report · Superatom'

const INDEX = `<!doctype html><meta charset="utf-8"><title>superatom-reporting</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#f5f3ef;color:#1a1a1a;margin:0;padding:48px 40px}
main{max-width:640px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:#6b6560;margin:0 0 28px}
a{color:#e55a1f;font-weight:600;text-decoration:none}li{margin-bottom:10px}code{background:#fff;border:1px solid #e8e4de;border-radius:6px;padding:1px 6px;font-size:13px}
ul{padding-left:18px}</style>
<main><h1>superatom-reporting</h1>
<p>Answer JSON &rarr; HTML or PNG. No headless browser.</p>
<ul>
<li><a href="/sample.png">/sample.png</a> — the sample report as an image <em>(the real check)</em></li>
<li><a href="/sample">/sample</a> — the same report as HTML, complete, nothing dropped</li>
<li>themes: <a href="/sample.png?theme=editorial">?theme=editorial</a> (default, matches the live answer card) · <a href="/sample.png?theme=paper">?theme=paper</a></li>
<li>knobs: <a href="/sample.png?scale=1">?scale=1</a> · <a href="/sample.png?rows=4">?rows=4</a></li>
<li><code>POST /render</code> and <code>POST /preview</code> with <code>{ "answer": { … } }</code></li>
</ul></main>`
