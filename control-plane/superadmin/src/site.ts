// superatom.site/ — the public home page: one screen, no scrolling, at any width. Plain HTML from the Worker, like
// /install; the apps keep their own addresses (a project's subdomain, /admin, /u, ?project=…).

export function homePage(): Response {
  const year = new Date().getUTCFullYear()
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superatom</title>
<meta name="description" content="Superatom. Decision intelligence for teams.">
<style>
:root{--bg:#fff;--ink:#111;--muted:#6b6b6b}
@media (prefers-color-scheme:dark){:root{--bg:#111;--ink:#eee;--muted:#8a8a8a}}
*{margin:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;height:100dvh;overflow:hidden;
  display:flex;flex-direction:column;justify-content:center;padding:0 clamp(24px,10vw,160px)}
h1{font-size:clamp(32px,5vw,56px);font-weight:600;letter-spacing:-.02em}
p{color:var(--muted);margin-top:8px;font-size:clamp(16px,1.6vw,20px)}
nav{margin-top:32px;display:flex;gap:24px}
a{color:var(--ink);text-decoration:underline;text-underline-offset:4px}
footer{position:fixed;bottom:24px;left:clamp(24px,10vw,160px);font-size:13px;color:var(--muted)}
</style></head><body>
<h1>Superatom</h1>
<p>Decision intelligence for teams.</p>
<nav><a href="https://admin.superatom.site">Sign in</a><a href="/install">Install</a></nav>
<footer>© ${year} Superatom</footer>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
