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
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13.5px}
.q{padding:14px 16px;border-bottom:1px solid var(--line);font-weight:500}
.q span{color:var(--muted);font-weight:400;margin-right:8px}
.a{padding:14px 16px}
.a p{margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--line)}
th{font-weight:500;color:var(--muted);font-size:12px;background:var(--soft)}
td:last-child,th:last-child{text-align:right}
.how{display:flex;flex-wrap:wrap;gap:6px 16px;padding:10px 16px;border-top:1px solid var(--line);background:var(--soft);color:var(--muted);font-size:12.5px}
.how b{color:var(--ink);font-weight:500}
footer{color:var(--muted);font-size:12.5px}
@media (max-width:860px){main{grid-template-columns:1fr}.card{display:none}}
@media (max-height:640px){.card{display:none}main{grid-template-columns:1fr}}
</style></head><body>
<header><b>Superatom</b><nav><a href="/install">Install</a><a href="https://admin.superatom.site">Sign in</a></nav></header>
<main>
  <div>
    <h1>Decision intelligence for Enterprise</h1>
    <p class="lead">Ask about your business in plain words. Superatom answers from your own data and shows how it got there: which data it used, how it calculated, and what it assumed. Your team can check it, run it again next week, and act on it.</p>
    <div class="cta"><a class="btn btn--dark" href="https://admin.superatom.site">Sign in</a><a class="btn" href="/install">Install the CLI</a></div>
  </div>
  <div class="card" aria-label="An example question and answer">
    <div class="q"><span>Asked</span>Which open orders will miss their delivery date?</div>
    <div class="a">
      <p><b>14 of 212</b> open orders are past their promised date, or will be at the current lead time.</p>
      <table>
        <thead><tr><th>Order</th><th>Customer</th><th>Promised</th><th>Days late</th></tr></thead>
        <tbody>
          <tr><td>SO-48213</td><td>Harbor Foods</td><td>2 Oct</td><td>11</td></tr>
          <tr><td>SO-48377</td><td>Kestrel Labs</td><td>6 Oct</td><td>7</td></tr>
          <tr><td>SO-48402</td><td>Linden &amp; Co</td><td>9 Oct</td><td>4</td></tr>
        </tbody>
      </table>
    </div>
    <div class="how"><span><b>Data</b> orders, shipments</span><span><b>Lead time</b> last 90 days, by supplier</span><span><b>Assumed</b> weekends excluded</span></div>
  </div>
</main>
<footer><span>© ${year} Superatom</span><span><a href="/agent.md">For AI agents</a></span></footer>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
