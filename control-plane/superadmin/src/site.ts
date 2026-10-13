// superatom.site/ — the public home page: one screen, no scrolling, at any width. Plain HTML from the Worker, like
// /install; the apps keep their own addresses (a project's subdomain, /admin, /u, ?project=…).

export function homePage(): Response {
  const year = new Date().getUTCFullYear()
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superatom</title>
<meta name="description" content="Superatom gives every team an agent that knows the business, works on its data, and shows its reasoning.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f5f1;--ink:#14171c;--muted:#5b6370;--line:#dedcd5;--card:#fbfaf7;--accent:#0f7a6c;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--ink:#eceef1;--muted:#9aa2ad;--line:#262a31;--card:#14171b;--accent:#4cc2b0;--accent-ink:#0e1013}}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:400 15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden;
  display:grid;grid-template-rows:auto 1fr auto;height:100dvh;padding:clamp(16px,3vw,32px) clamp(16px,5vw,64px)}
a{color:inherit;text-decoration:none}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em;font-size:16px}
.mark{width:22px;height:22px;border-radius:50%;border:2px solid var(--ink);position:relative}
.mark::after{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--accent)}
nav{display:flex;gap:clamp(12px,2vw,24px);font-size:14px;color:var(--muted)}
nav a:hover,footer a:hover{color:var(--ink)}
main{display:grid;align-content:center;gap:clamp(20px,4vh,44px);max-width:1120px;width:100%;margin:0 auto;min-height:0}
h1{font:400 clamp(36px,6.4vw,84px)/1.02 "Instrument Serif",Georgia,serif;letter-spacing:-.02em;max-width:14ch}
h1 em{color:var(--accent)}
.lead{font-size:clamp(15px,1.5vw,18px);color:var(--muted);max-width:56ch}
.cta{display:flex;flex-wrap:wrap;gap:10px}
.btn{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 18px;border-radius:999px;border:1px solid var(--line);font-weight:500;font-size:14px;transition:border-color .15s,background .15s}
.btn:hover{border-color:var(--ink)}
.btn--primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn--primary:hover{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.pillars{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--line)}
.pillar{padding:clamp(12px,2vh,22px) clamp(0px,2vw,24px) 0 0}
.pillar+.pillar{padding-left:clamp(12px,2vw,24px);border-left:1px solid var(--line)}
.pillar b{display:block;font-weight:600;font-size:14px;margin-bottom:4px}
.pillar span{color:var(--muted);font-size:13.5px}
.n{font:italic 400 15px "Instrument Serif",Georgia,serif;color:var(--accent);margin-right:6px}
footer{font-size:12.5px;color:var(--muted)}
@media (max-width:720px){
  nav .opt{display:none}
  .pillars{grid-template-columns:1fr}
  .pillar,.pillar+.pillar{padding:10px 0 0;border-left:0}
  .pillar+.pillar{border-top:1px solid var(--line);margin-top:10px}
  .pillar span{display:none}
}
@media (max-height:620px){.pillars{display:none}}
</style></head><body>
<header>
  <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Superatom</a>
  <nav><a class="opt" href="/install">Install</a><a class="opt" href="/agent.md">For agents</a><a href="https://admin.superatom.site">Sign in</a></nav>
</header>
<main>
  <h1>Decisions, with the <em>reasoning</em> shown.</h1>
  <p class="lead">Superatom gives every team an agent that knows your business, works on your own data, and shows how it reached each answer — so you can act on it.</p>
  <div class="cta">
    <a class="btn btn--primary" href="https://admin.superatom.site">Sign in</a>
    <a class="btn" href="/install">Install the CLI</a>
  </div>
  <div class="pillars">
    <div class="pillar"><b><span class="n">i.</span>Knows your business</b><span>What your terms, rules and numbers mean — written once, in plain words, and kept up to date.</span></div>
    <div class="pillar"><b><span class="n">ii.</span>Works on your data</b><span>Every answer is computed from your systems, and can be run again — never a guess.</span></div>
    <div class="pillar"><b><span class="n">iii.</span>Yours to govern</b><span>Roles, keys and a full history of every question and change, for every team.</span></div>
  </div>
</main>
<footer><span>© ${year} Superatom</span><span><a href="/install">Install</a> · <a href="/agent.md">agent.md</a></span></footer>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
