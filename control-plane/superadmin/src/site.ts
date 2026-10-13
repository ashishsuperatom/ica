// superatom.site/ — the public home page: one screen, no scrolling, at any width. Plain HTML from the Worker, like
// /install; the apps keep their own addresses (a project's subdomain, /admin, /u, ?project=…).

export function homePage(): Response {
  const year = new Date().getUTCFullYear()
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superatom</title>
<meta name="description" content="Decision intelligence for Enterprise. Ask about your business in plain words; Superatom answers from your own data and shows how it got there.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#fbfbfa;--ink:#0f1115;--muted:#6a707a;--faint:#a3a8b0;--line:#e6e7e9;--panel:#ffffff;--wash:#e8f4f1;--accent:#0f7a6c;--grid:#eceded}
@media (prefers-color-scheme:dark){:root{--bg:#0c0d10;--ink:#eef0f3;--muted:#949aa4;--faint:#5c626c;--line:#23262c;--panel:#111317;--wash:#12302b;--accent:#4cc2b0;--grid:#1a1c21}}
*{margin:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;height:100dvh;overflow:hidden;
  display:grid;grid-template-rows:auto 1fr auto;padding:22px clamp(20px,5vw,72px);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
header,footer{display:flex;justify-content:space-between;align-items:center;max-width:1240px;width:100%;margin:0 auto}
.brand{font-weight:700;font-size:16px;letter-spacing:-.02em}
header nav{display:flex;align-items:center;gap:22px;font-size:14px;color:var(--muted)}
header nav a:hover{color:var(--ink)}
header nav .in{color:var(--ink);border:1px solid var(--line);padding:6px 12px;border-radius:7px}
header nav .in:hover{border-color:var(--ink)}
main{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr);gap:clamp(32px,5vw,80px);align-items:center;max-width:1240px;width:100%;margin:0 auto;min-height:0}
.kicker{font-size:13px;font-weight:500;color:var(--accent);margin-bottom:14px}
h1{font-size:clamp(34px,4.2vw,58px);line-height:1.04;font-weight:600;letter-spacing:-.035em}
.lead{color:var(--muted);margin-top:20px;font-size:clamp(15px,1.25vw,17px);line-height:1.6;max-width:44ch}
.cta{margin-top:30px;display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;height:42px;padding:0 18px;border:1px solid var(--line);border-radius:8px;font-weight:500;font-size:14px;transition:border-color .15s,background .15s,color .15s}
.btn:hover{border-color:var(--ink)}
.btn--dark{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn--dark:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.graph{position:relative;height:min(64vh,540px);margin:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.graph canvas{position:absolute;inset:0;width:100%;height:100%}
footer{color:var(--faint);font-size:12.5px}
footer a:hover{color:var(--ink)}
@media (max-width:900px){main{grid-template-columns:1fr}.graph{display:none}}
@media (max-height:640px){.graph{display:none}main{grid-template-columns:1fr}}
</style></head><body>
<header><a class="brand" href="/">Superatom</a><nav><a href="/install">Install</a><a class="in" href="https://admin.superatom.site">Sign in</a></nav></header>
<main>
  <div>
    <h1>Decision intelligence for Enterprise</h1>
    <p class="lead">Ask about your business in plain words. Superatom answers from your own data and shows how it got there: which data it used, how it calculated, and what it assumed. Your team can check it, run it again, and act on it.</p>
    <div class="cta"><a class="btn btn--dark" href="https://admin.superatom.site">Sign in</a><a class="btn" href="/install">Install the CLI</a></div>
  </div>
  <figure class="graph" aria-label="Data flowing into what it means, and into decisions"><canvas id="g"></canvas></figure>
</main>
<footer><span>© ${year} Superatom</span><a href="/agent.md">For AI agents</a></footer>
<script>
(() => {
  const cv = document.getElementById('g'); if (!cv || !cv.getContext) return
  const ctx = cv.getContext('2d'), root = document.documentElement
  const col = (n) => getComputedStyle(root).getPropertyValue(n).trim()
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const FONT = '500 12px Inter,system-ui,-apple-system,sans-serif', SMALL = '500 10px Inter,system-ui,sans-serif'
  const COLS = [
    { title: 'DATA', names: ['Orders', 'Shipments', 'Invoices', 'Inventory', 'Suppliers', 'Payments'] },
    { title: 'WHAT IT MEANS', names: ['Lead time', 'Gross margin', 'Credit risk', 'Demand forecast', 'On-time rate'] },
    { title: 'DECISIONS', names: ['Expedite SO-48213', 'Reorder 400 units', 'Hold supplier payment', 'Raise credit limit', 'Move delivery to Fri'] },
  ]
  let W = 0, H = 0, nodes = [], links = [], pulses = [], last = 0
  function build() {
    nodes = COLS.flatMap((c, k) => c.names.map((label, i) => ({ k, i, n: c.names.length, label, ph: Math.random() * 6.28, lit: 0 })))
    links = []
    const at = (k) => nodes.filter((n) => n.k === k)
    for (const [a, b] of [[0, 1], [1, 2]]) {
      for (const n of at(a)) for (const m of [...at(b)].sort(() => Math.random() - .5).slice(0, 2)) links.push({ a: n, b: m })
      for (const m of at(b)) if (!links.some((l) => l.b === m)) links.push({ a: at(a)[Math.floor(Math.random() * at(a).length)], b: m })
    }
  }
  function size() {
    const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height; cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.font = FONT
    for (const n of nodes) n.w = Math.ceil(ctx.measureText(n.label).width) + (n.k === 2 ? 40 : 30)
  }
  const TOP = 56, PADX = 22
  function box(n, t) {
    const span = H - TOP - 26, y = TOP + span * (n.i + .5) / n.n + (still ? 0 : Math.sin(t / 2600 + n.ph) * 2.5)
    const x = n.k === 0 ? PADX : n.k === 2 ? W - PADX - n.w : W / 2 - n.w / 2
    return { x, y, w: n.w, h: n.k === 2 ? 30 : 26 }
  }
  const round = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  const ends = (l, t) => { const A = box(l.a, t), B = box(l.b, t); return [A.x + A.w, A.y, B.x, B.y] }
  const bez = (x1, y1, x2, y2, u) => { const mx = (x1 + x2) / 2, v = 1 - u; return [v*v*v*x1 + 3*v*v*u*mx + 3*v*u*u*mx + u*u*u*x2, v*v*v*y1 + 3*v*v*u*y1 + 3*v*u*u*y2 + u*u*u*y2] }
  function draw(t) {
    const C = { ink: col('--ink'), muted: col('--muted'), faint: col('--faint'), line: col('--line'), panel: col('--panel'), wash: col('--wash'), accent: col('--accent'), grid: col('--grid') }
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = C.grid
    for (let x = 12; x < W; x += 18) for (let y = 12; y < H; y += 18) ctx.fillRect(x, y, 1, 1)
    ctx.font = SMALL; ctx.fillStyle = C.faint; ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'; ctx.fillText(COLS[0].title, PADX, 28)
    ctx.textAlign = 'center'; ctx.fillText(COLS[1].title, W / 2, 28)
    ctx.textAlign = 'right'; ctx.fillText(COLS[2].title, W - PADX, 28)
    ctx.fillStyle = C.line; ctx.fillRect(0, 46, W, 1)
    ctx.lineWidth = 1
    for (const l of links) {
      const [x1, y1, x2, y2] = ends(l, t), mx = (x1 + x2) / 2
      ctx.strokeStyle = l.hot > 0 ? C.accent : C.line; ctx.globalAlpha = l.hot > 0 ? .35 + .65 * l.hot : 1
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2); ctx.stroke(); ctx.globalAlpha = 1
      l.hot = Math.max(0, (l.hot || 0) - .02)
    }
    for (const q of pulses) {
      q.p = Math.min(1, q.p + .016)
      const [x1, y1, x2, y2] = ends(q.l, t)
      for (let s = 0; s < 8; s++) {
        const u = q.p - s * .018; if (u < 0) break
        const [x, y] = bez(x1, y1, x2, y2, u)
        ctx.globalAlpha = 1 - s / 8; ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(x, y, s ? 1.6 : 2.6, 0, 6.29); ctx.fill()
      }
      ctx.globalAlpha = 1
      if (q.p >= 1 && !q.done) {
        q.done = true; q.l.b.lit = 1; q.l.hot = 1
        const next = links.filter((l) => l.a === q.l.b)
        if (next.length) pulses.push({ l: next[Math.floor(Math.random() * next.length)], p: 0 })
      }
    }
    pulses = pulses.filter((q) => !q.done)
    ctx.font = FONT; ctx.textBaseline = 'middle'
    for (const n of nodes) {
      const b = box(n, t), lit = n.lit; n.lit = Math.max(0, n.lit - (n.k === 2 ? .006 : .012))
      round(b.x, b.y - b.h / 2, b.w, b.h, n.k === 2 ? 8 : b.h / 2)
      ctx.fillStyle = lit > .05 ? C.wash : C.panel; ctx.fill()
      ctx.strokeStyle = lit > .05 ? C.accent : (n.k === 2 ? C.muted : C.line); ctx.lineWidth = 1; ctx.stroke()
      if (n.k === 2) {
        ctx.fillStyle = lit > .05 ? C.accent : C.faint
        ctx.beginPath(); ctx.arc(b.x + 14, b.y, 4, 0, 6.29); ctx.fill()
        ctx.fillStyle = lit > .05 ? C.ink : C.muted; ctx.textAlign = 'left'; ctx.fillText(n.label, b.x + 26, b.y)
      } else {
        ctx.fillStyle = lit > .05 ? C.accent : C.faint
        ctx.beginPath(); ctx.arc(b.x + 12, b.y, 2.5, 0, 6.29); ctx.fill()
        ctx.fillStyle = lit > .05 ? C.ink : C.muted; ctx.textAlign = 'left'; ctx.fillText(n.label, b.x + 21, b.y)
      }
    }
  }
  function loop(t) {
    if (t - last > 900) { const s = links.filter((l) => l.a.k === 0); const l = s[Math.floor(Math.random() * s.length)]; l.a.lit = 1; pulses.push({ l, p: 0 }); last = t }
    draw(t); requestAnimationFrame(loop)
  }
  build(); size()
  addEventListener('resize', () => { size(); if (still) draw(0) })
  document.fonts?.ready.then(() => { size(); if (still) draw(0) })
  if (still) { nodes.filter((n) => n.k === 2).slice(0, 2).forEach((n) => n.lit = 1); draw(0) } else requestAnimationFrame(loop)
})()
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
