// ── superatom-reporting ──────────────────────────────────────────────────────
// An Answer goes in, a report comes out — as a browser page, a PNG for chat, or a
// CSV of the underlying data. The service renders and stores; it NEVER sends, and it
// has never heard of Teams, Slack or email. Callers get URLs and choose the surface.
//
//   POST /render                       { projectId, questionId, answer, … } → { id, html, png, csv }
//   GET  /r/:projectId/:id             the report as HTML   (complete — nothing dropped)
//   GET  /r/:projectId/:id.png         the report as a PNG  (fitted; announces what it dropped)
//   GET  /r/:projectId/:id.csv         the data             (complete)
//   GET  /sample, /sample.png          the sample report, no storage, no auth
//
// A report is IMMUTABLE and identified by (projectId, questionId) — see auth.ts. The
// PNG renders LAZILY on first request and is then cached in R2 and at the edge, so a
// report nobody opens is never paid for, and the POST path stays fast (the engine is
// waiting on it).

import { renderImage, type ImageOptions } from './render/image.js'
import { renderDocument } from './render/html.js'
import { resolveTheme, THEMES } from './render/theme.js'
import { DEFAULT_LIMITS } from './render/fit.js'
import { answerToCsv, reportFilename } from './render/csv.js'
import { renderer } from './renderer.js'
import { sampleAnswer } from './sample.js'
import { authorised, isSafeId, reportId } from './auth.js'
import { getBytes, getJson, jsonKey, pngKey, putBytes, putJson } from './store.js'
import type { Answer, StoredReport } from './types.js'

interface Env {
  REPORTS: R2Bucket
  SERVICE_TOKEN?: string
  SIGNING_KEY?: string
  PUBLIC_ORIGIN?: string
}

// COUPLED to the R2 lifecycle rule `reporting-expiry` on the `frontend-packages`
// bucket, which expires objects under the `reporting/` prefix after 31 days. The rule
// works on object AGE, not on our `expiresAt` metadata, so the two only agree while
// this is a CONSTANT. Storage is given one extra day so the read path (which returns
// 410 Gone) is always the authority on whether a report is viewable, and deletion is
// purely a cost cleanup that can never race ahead of it.
// If TTL ever becomes per-report, the lifecycle rule can no longer express it — drop
// the rule and replace it with a scheduled cleanup over the prefix.
const TTL_DAYS = 30
const DEFAULT_SCALE = 2

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { 'content-type': 'application/json' } })
const htmlRes = (b: string, status = 200, cache = 'no-store') =>
  new Response(b, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache } })

/** Rendered artefacts are immutable for a given (report, scale, theme), so they can be
 *  cached hard. The report id already changes when the question changes. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = env.PUBLIC_ORIGIN || url.origin

    try {
      // ── Write ───────────────────────────────────────────────────────────────
      if (request.method === 'POST' && path === '/render') {
        if (!authorised(request, env.SERVICE_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401)
        if (!env.SIGNING_KEY) return json({ ok: false, error: 'SIGNING_KEY not configured' }, 500)

        const body = await request.json().catch(() => null) as null | {
          projectId?: string; questionId?: string; answer?: Answer
          title?: string; category?: string; theme?: string; source?: string
        }
        if (!body?.answer || !isSafeId(body.projectId) || !isSafeId(body.questionId)) {
          return json({ ok: false, error: 'projectId, questionId and answer are required (ids: [A-Za-z0-9_-])' }, 400)
        }

        const id = await reportId(env.SIGNING_KEY, body.projectId, body.questionId)
        const base0 = `${origin}/r/${body.projectId}/${id}`

        // A report is IMMUTABLE. If this (projectId, questionId) already has one, return
        // it untouched rather than overwriting: renders of the old answer may already be
        // cached in R2 and at the edge, and overwriting the JSON alone would leave the
        // image and the page disagreeing about what the answer was.
        const existing = await getJson<StoredReport>(env.REPORTS, jsonKey(body.projectId, id))
        if (existing) {
          return json({ ok: true, id, expiresAt: existing.expiresAt, reused: true,
            html: base0, png: `${base0}.png`, csv: `${base0}.csv` })
        }

        const expiresAt = Date.now() + TTL_DAYS * 86400_000
        const report: StoredReport = {
          meta: {
            id, projectId: body.projectId, title: body.title,
            createdAt: Date.now(), expiresAt, source: body.source,
          },
          answer: body.category ? { ...body.answer, category: body.answer.category ?? body.category } : body.answer,
        }
        // Store the ANSWER only. The PNG is not rendered here: the caller is a live
        // turn waiting on this response, and an image nobody opens is wasted work.
        await putJson(env.REPORTS, jsonKey(body.projectId, id), report, expiresAt)

        const base = `${origin}/r/${body.projectId}/${id}`
        return json({
          ok: true, id, expiresAt,
          html: base, png: `${base}.png`, csv: `${base}.csv`,
        })
      }

      // ── Read ────────────────────────────────────────────────────────────────
      const m = path.match(/^\/r\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(\.png|\.csv)?$/)
      if (request.method === 'GET' && m) {
        const [, projectId, id, ext] = m
        const stored = await getJson<StoredReport>(env.REPORTS, jsonKey(projectId, id))
        if (!stored) return notFound(ext)
        // Expiry is enforced HERE rather than by a bucket lifecycle rule: this bucket
        // is shared, and a rule written for other artefacts must not govern reports.
        if (stored.expiresAt && Date.now() > stored.expiresAt) return gone(ext)

        const { answer, meta } = stored.value
        const theme = (url.searchParams.get('theme') && THEMES[url.searchParams.get('theme')!]) ? url.searchParams.get('theme')! : 'editorial'

        if (ext === '.csv') {
          return new Response(answerToCsv(answer, meta.title), {
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${reportFilename(meta.title, id, 'csv')}"`,
              'cache-control': IMMUTABLE,
            },
          })
        }

        if (ext === '.png') {
          const scale = clampScale(url.searchParams.get('scale'))
          const key = pngKey(projectId, id, scale, theme)

          // Edge cache first, then R2, then render. Three tiers, cheapest first.
          const cache = caches.default
          const hit = await cache.match(request)
          if (hit) return hit

          const cached = await getBytes(env.REPORTS, key)
          if (cached) {
            const bytes = await cached.arrayBuffer()
            const fn = reportFilename(meta.title, id, 'png')
            ctx.waitUntil(cache.put(request, imageResponse(bytes, 'edge', undefined, fn)))
            return imageResponse(bytes, 'r2', undefined, fn)
          }

          const out = await renderImage(answer, await renderer(), {
            theme, scale, title: meta.title,
            footerLeft: footer(meta.createdAt),
            footerRight: 'View the full report',
          })
          const fit = `rows=${out.fit.droppedRows} cols=${out.fit.droppedCols} figures=${out.fit.droppedFigures} sections=${out.fit.droppedSections}`
          // Persist and edge-cache AFTER responding — the requester never waits on it.
          const fn = reportFilename(meta.title, id, 'png')
          ctx.waitUntil(Promise.all([
            putBytes(env.REPORTS, key, out.bytes, out.contentType, stored.expiresAt),
            cache.put(request, imageResponse(out.bytes, 'edge', fit, fn)),
          ]))
          return imageResponse(out.bytes, 'miss', fit, fn)
        }

        // HTML: the complete report. No fit pass — this is what the image links to.
        return htmlRes(renderDocument(answer, {
          theme: resolveTheme(theme), scale: 1, surface: 'web', title: meta.title,
          footerLeft: footer(meta.createdAt),
          footerRight: 'Download the data (CSV)',
        }), 200, IMMUTABLE)
      }

      // ── Sample (no storage, no auth) ────────────────────────────────────────
      if (request.method === 'GET' && (path === '/sample.png' || path === '/sample')) {
        const theme = (url.searchParams.get('theme') && THEMES[url.searchParams.get('theme')!]) ? url.searchParams.get('theme')! : 'editorial'
        const opts = {
          theme, title: SAMPLE_TITLE, footerLeft: 'Sample report · Superatom',
          footerRight: path === '/sample' ? 'Download the data (CSV)' : 'View the full report',
        }
        if (path === '/sample') return htmlRes(renderDocument(sampleAnswer, { ...opts, theme: resolveTheme(theme), scale: 1, surface: 'web' }))
        const rows = url.searchParams.get('rows')
        const out = await renderImage(sampleAnswer, await renderer(), {
          ...opts, scale: clampScale(url.searchParams.get('scale')),
          limits: rows ? { ...DEFAULT_LIMITS, maxRows: Number(rows) } : undefined,
        } as ImageOptions)
        return new Response(out.bytes as BodyInit, { headers: { 'content-type': out.contentType, 'cache-control': 'no-store' } })
      }
      if (request.method === 'GET' && path === '/sample.csv') {
        return new Response(answerToCsv(sampleAnswer, SAMPLE_TITLE), {
          headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${reportFilename(SAMPLE_TITLE, 'sample00', 'csv')}"` },
        })
      }

      if (request.method === 'GET' && path === '/') return htmlRes(INDEX)
      return json({ ok: false, error: 'not found' }, 404)
    } catch (e: unknown) {
      // Never swallow a render failure into a blank image: a broken report must LOOK
      // broken, so nobody acts on an empty one.
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
      console.log('[reporting] failed:', msg)
      return json({ ok: false, error: msg }, 500)
    }
  },
}

/** One place that builds an image response, so the copy we hand back and the copy we
 *  put in the cache can only differ in the tier label. */
function imageResponse(bytes: ArrayBuffer | Uint8Array, tier: 'miss' | 'r2' | 'edge', fit?: string, filename?: string): Response {
  const h: Record<string, string> = { 'content-type': 'image/png', 'cache-control': IMMUTABLE, 'x-cache': tier }
  // `inline`, NOT `attachment`: the image must still DISPLAY in a card or a browser.
  // The filename is only a hint for when someone saves it — without it the client falls
  // back to the last URL segment, which is an opaque id.
  if (filename) h['content-disposition'] = `inline; filename="${filename}"`
  if (fit) h['x-fit-dropped'] = fit
  return new Response(bytes as BodyInit, { headers: h })
}

/** 1×–3×. Anything outside is a caller mistake, not a request to burn CPU. */
function clampScale(v: string | null): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n : DEFAULT_SCALE
}

const footer = (at: number) =>
  `Generated ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · Superatom`

// A missing/expired IMAGE must not return an HTML error page — a chat client would
// render a broken-image box with no explanation. It gets a tiny explanatory PNG-shaped
// failure instead: a plain 404 with no body, which clients show as a failed image.
const notFound = (ext?: string) =>
  ext ? new Response(null, { status: 404 }) : htmlRes(page('Report not found', 'This report does not exist, or its link is wrong.'), 404)
const gone = (ext?: string) =>
  ext ? new Response(null, { status: 410 }) : htmlRes(page('Report expired', `Reports are kept for ${TTL_DAYS} days. Ask the question again to get a fresh one.`), 410)

const page = (h: string, p: string) => `<!doctype html><meta charset="utf-8"><title>${h}</title>
<style>body{font:15px/1.6 'Helvetica Neue',Helvetica,Arial,system-ui,sans-serif;color:#33373c;margin:0;padding:80px 40px;text-align:center}
h1{font-size:19px;color:#161719;margin:0 0 6px}p{color:#6c7075;margin:0}</style><h1>${h}</h1><p>${p}</p>`

const SAMPLE_TITLE = 'Which branches make money, and which are dragging the network down?'

const INDEX = `<!doctype html><meta charset="utf-8"><title>superatom-reporting</title>
<style>body{font:15px/1.7 'Helvetica Neue',Helvetica,Arial,system-ui,sans-serif;color:#33373c;margin:0;padding:56px 40px}
main{max-width:660px;margin:0 auto}h1{font-size:20px;color:#161719;margin:0 0 4px}
h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#15385c;margin:30px 0 8px}
p{color:#6c7075;margin:0 0 8px}a{color:#15385c;font-weight:600;text-decoration:none}
code{background:#f6f7f9;border:1px solid #e2e4e8;border-radius:3px;padding:1px 6px;font-size:13px}
ul{padding-left:18px;margin:0}li{margin-bottom:6px}</style>
<main><h1>superatom-reporting</h1>
<p>Answer JSON &rarr; HTML, PNG or CSV. No headless browser. Renders and stores; never sends.</p>
<h2>Try it</h2>
<ul>
<li><a href="/sample.png">/sample.png</a> — the sample report as an image</li>
<li><a href="/sample">/sample</a> — the same report as HTML, complete</li>
<li><a href="/sample.csv">/sample.csv</a> — the data behind it</li>
<li>themes: <a href="/sample.png?theme=editorial">editorial</a> · <a href="/sample.png?theme=paper">paper</a> · knobs: <code>?scale=</code> <code>?rows=</code></li>
</ul>
<h2>API</h2>
<ul>
<li><code>POST /render</code> &mdash; <code>Bearer</code> service token; body <code>{ projectId, questionId, answer, title? }</code><br/>returns <code>{ id, html, png, csv, expiresAt }</code></li>
<li><code>GET /r/:projectId/:id</code> &middot; <code>.png</code> &middot; <code>.csv</code></li>
</ul>
<p>A report is identified by <code>projectId</code> + <code>questionId</code>, so re-POSTing the same turn is idempotent. Links expire after ${TTL_DAYS} days.</p>
</main>`
