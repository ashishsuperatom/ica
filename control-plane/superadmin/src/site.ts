// superatom.site/ — the public home page: one screen, no scrolling, at any width. Plain HTML from the Worker, like
// /install; the apps keep their own addresses (a project's subdomain, /admin, /u, ?project=…).

export function homePage(): Response {
  const year = new Date().getUTCFullYear()
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superatom</title>
<meta name="description" content="Decision intelligence for Enterprise. Ask about your business in plain words; Superatom answers from your own data and shows how it got there.">
<style>
:root{--bg:#fafaf9;--ink:#161616;--muted:#6b6b6b;--line:#e4e4e1;--card:#fff;--soft:#f3f3f1;--accent:#0f7a6c}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--ink:#ececec;--muted:#8d8d8d;--line:#2a2a2a;--card:#181818;--soft:#1f1f1f;--accent:#4cc2b0}}
*{margin:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;height:100dvh;overflow:hidden;
  display:grid;grid-template-rows:auto 1fr auto;padding:24px clamp(20px,6vw,88px)}
a{color:inherit}
header,footer{display:flex;justify-content:space-between;align-items:center;font-size:14px}
header b{font-size:16px;letter-spacing:-.01em}
header nav{display:flex;gap:20px;color:var(--muted)}
header nav a{text-decoration:none}header nav a:hover{color:var(--ink)}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:clamp(32px,6vw,96px);align-items:center;max-width:1180px;width:100%;margin:0 auto;min-height:0}
h1{font-size:clamp(30px,3.6vw,46px);line-height:1.12;font-weight:600;letter-spacing:-.02em;max-width:15ch}
.lead{color:var(--muted);margin-top:16px;font-size:clamp(15px,1.3vw,17px);max-width:46ch}
.cta{margin-top:28px;display:flex;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;padding:10px 16px;border:1px solid var(--line);border-radius:6px;text-decoration:none;font-weight:500;font-size:14px}
.btn:hover{border-color:var(--ink)}
.btn--dark{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.graph{position:relative;height:min(62vh,520px);margin:0;border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}
.graph canvas{position:absolute;inset:0;width:100%;height:100%}
.graph figcaption{position:absolute;left:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(3,1fr);padding:10px 16px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-top:1px solid var(--line);background:var(--soft)}
.graph figcaption span:nth-child(2){text-align:center}.graph figcaption span:last-child{text-align:right}
footer{color:var(--muted);font-size:12.5px}
@media (max-width:860px){main{grid-template-columns:1fr}.graph{display:none}}
@media (max-height:640px){.graph{display:none}main{grid-template-columns:1fr}}
</style></head><body>
<header><b>Superatom</b><nav><a href="/install">Install</a><a href="https://admin.superatom.site">Sign in</a></nav></header>
<main>
  <div>
    <h1>Decision intelligence for Enterprise</h1>
    <p class="lead">Ask about your business in plain words. Superatom answers from your own data and shows how it got there: which data it used, how it calculated, and what it assumed. Your team can check it, run it again next week, and act on it.</p>
    <div class="cta"><a class="btn btn--dark" href="https://admin.superatom.site">Sign in</a><a class="btn" href="/install">Install the CLI</a></div>
  </div>
  <figure class="graph" aria-label="Data flowing into what it means, and into decisions">
    <canvas id="g"></canvas>
    <figcaption><span>Data</span><span>What it means</span><span>Decisions</span></figcaption>
  </figure>
</main>
<footer><span>© ${year} Superatom</span><span><a href="/agent.md">For AI agents</a></span></footer>
<script>
(() => {
  const cv = document.getElementById('g'); if (!cv || !cv.getContext) return
  const ctx = cv.getContext('2d'), css = getComputedStyle(document.documentElement)
  const col = (n) => css.getPropertyValue(n).trim()
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const DATA = ['Orders', 'Shipments', 'Invoices', 'Stock', 'Suppliers', 'Payments']
  const MEANS = ['Lead time', 'Margin', 'Credit risk', 'Demand', 'On-time rate']
  const DECIDE = ['Expedite SO-48213', 'Reorder 400 units', 'Hold supplier payment', 'Raise credit limit', 'Move delivery to Friday', 'Review invoice INV-1172']
  let W = 0, H = 0, nodes = [], links = [], pulses = [], t0 = performance.now()
  const layer = (names, x, kind) => names.map((label, i) => ({ label, kind, x, y: (i + 1) / (names.length + 1), ph: Math.random() * 6.28, lit: 0 }))
  function build() {
    const d = layer(DATA, .12, 0), m = layer(MEANS, .5, 1), c = layer(DECIDE, .86, 2)
    nodes = [...d, ...m, ...c]; links = []
    const join = (from, to, k) => from.forEach((a) => { const pick = [...to].sort(() => Math.random() - .5).slice(0, k); pick.forEach((b) => links.push({ a, b })) })
    join(d, m, 2); join(m, c, 2)
    c.forEach((b) => { if (!links.some((l) => l.b === b)) links.push({ a: m[Math.floor(Math.random() * m.length)], b }) })
  }
  function size() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height - 38; cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const pos = (n, t) => [n.x * W + Math.sin(t / 2400 + n.ph) * 6, 14 + n.y * (H - 28) + Math.cos(t / 2900 + n.ph) * 5]
  function spawn() {
    const starts = links.filter((l) => l.a.kind === 0); const l = starts[Math.floor(Math.random() * starts.length)]
    pulses.push({ l, p: 0 })
  }
  function frame(t) {
    const ink = col('--ink'), muted = col('--muted'), line = col('--line'), accent = col('--accent'), card = col('--card')
    ctx.clearRect(0, 0, W, H + 38)
    ctx.lineWidth = 1
    for (const { a, b } of links) {
      const [x1, y1] = pos(a, t), [x2, y2] = pos(b, t), mx = (x1 + x2) / 2
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2); ctx.stroke()
    }
    for (const q of pulses) {
      q.p += 0.012
      const [x1, y1] = pos(q.l.a, t), [x2, y2] = pos(q.l.b, t), mx = (x1 + x2) / 2, u = q.p, v = 1 - u
      const x = v*v*v*x1 + 3*v*v*u*mx + 3*v*u*u*mx + u*u*u*x2, y = v*v*v*y1 + 3*v*v*u*y1 + 3*v*u*u*y2 + u*u*u*y2
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.29); ctx.fill()
      if (q.p >= 1) {
        q.l.b.lit = 1
        const next = links.filter((l) => l.a === q.l.b)
        if (next.length) pulses.push({ l: next[Math.floor(Math.random() * next.length)], p: 0 })
      }
    }
    pulses = pulses.filter((q) => q.p < 1)
    ctx.font = '12px system-ui,-apple-system,Segoe UI,sans-serif'; ctx.textBaseline = 'middle'
    for (const n of nodes) {
      const [x, y] = pos(n, t); n.lit = Math.max(0, n.lit - 0.006)
      const r = n.kind === 2 ? 6 : n.kind === 1 ? 5 : 4
      ctx.fillStyle = card; ctx.strokeStyle = n.lit > 0 ? accent : (n.kind === 2 ? ink : muted); ctx.lineWidth = n.kind === 2 ? 1.5 : 1
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.29); ctx.fill(); ctx.stroke()
      if (n.lit > 0) { ctx.fillStyle = accent; ctx.globalAlpha = n.lit; ctx.beginPath(); ctx.arc(x, y, r - 2, 0, 6.29); ctx.fill(); ctx.globalAlpha = 1 }
      ctx.fillStyle = n.kind === 2 ? (n.lit > 0 ? ink : muted) : muted
      if (n.kind === 2) { ctx.textAlign = 'right'; ctx.fillText(n.label, x - 12, y) }
      else if (n.kind === 0) { ctx.textAlign = 'left'; ctx.fillText(n.label, x + 10, y - 12) }
      else { ctx.textAlign = 'center'; ctx.fillText(n.label, x, y - 15) }
    }
  }
  function loop(t) { if (t - t0 > 700) { spawn(); t0 = t } frame(t); requestAnimationFrame(loop) }
  build(); size(); addEventListener('resize', size)
  if (still) { nodes.filter((n) => n.kind === 2).slice(0, 2).forEach((n) => n.lit = 1); frame(0) } else requestAnimationFrame(loop)
})()
</script>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
