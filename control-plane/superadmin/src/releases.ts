// What we ship, served from the registry bucket (docs/releases.md). Two hosts, both read-only:
//
//   get.superatom.site        every product's releases — sacli now, anything later — laid out the same way:
//                               releases/<product>/<version>/<file>       never changed once written
//                               releases/<product>/<version>/manifest.json  what the version holds: each file's size and sha256
//                               releases/<product>/channels/<channel>.json  which version a channel (latest, beta…) names
//                             /<product>/install.sh is that product's installer at its latest version: each product
//                             installs itself (sacli now; the engine's own later), so there is no bare /install.sh.
//   registry.superatom.site   the engine's images, the same files registry.superatom.ai serves (the bucket's custom domain),
//                             for sites that reach only *.superatom.site.
//
// Nothing here writes: publishing is scripts/release.sh (and scripts/registry-push.sh for images), with a key for the
// bucket that only the `dev` branch's GitHub environment holds.

const IMMUTABLE = 'public, max-age=31536000, immutable'
const MOVING = 'public, max-age=60'
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface Manifest { product: string; version: string; commit?: string; at: string; files: { name: string; size: number; sha256: string }[] }
export interface Channel { product: string; channel: string; version: string; at: string }

const text = (body: string, status = 200, cache = 'no-store') => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache } })
const json = (body: unknown, cache = 'no-store', status = 200) => new Response(JSON.stringify(body, null, 2) + '\n', { status, headers: { 'content-type': 'application/json', 'cache-control': cache } })
const notFound = (what: string) => text(`${what}\nWhat there is: https://get.superatom.site/\n`, 404)

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const o = await bucket.get(key)
  return o ? (await o.json().catch(() => null)) as T | null : null
}

/** A version or a channel, as the version it is now; null when it is neither. */
async function resolve(bucket: R2Bucket, product: string, ref: string): Promise<{ version: string; channel?: string } | null> {
  const ch = await readJson<Channel>(bucket, `releases/${product}/channels/${ref}.json`)
  if (ch?.version) return { version: ch.version, channel: ref }
  return (await bucket.head(`releases/${product}/${ref}/manifest.json`)) ? { version: ref } : null
}

const TYPES: Record<string, string> = { sh: 'text/x-shellscript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8' }
const typeOf = (name: string) => TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream'

/**
 *   /                                  the products and what each channel names
 *   /<product>/install.sh              its installer, latest (install.sh is never a version's name)
 *   /<product>                         its channels and versions
 *   /<product>/<version|channel>       that version's manifest
 *   /<product>/<version|channel>/<file>  the file; through a channel it is served as the version it names now
 */
export async function handleGetHost(request: Request, bucket: R2Bucket | undefined): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('get.superatom.site only serves files\n', 405)
  if (!bucket) return text('releases are not available right now\n', 503)
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  if (parts.length === 2 && parts[1] === 'install.sh') parts.splice(1, 0, 'latest')
  if (!parts.every((p) => NAME.test(p))) return notFound('No such release.')

  // A person opening get.superatom.site in a browser gets the page that explains it; tools get the data.
  if (!parts.length && (request.headers.get('accept') ?? '').includes('text/html')) return Response.redirect('https://superatom.site/install', 302)
  if (!parts.length) {
    const listed = await bucket.list({ prefix: 'releases/', delimiter: '/' })
    const products = listed.delimitedPrefixes.map((p) => p.slice('releases/'.length, -1))
    const channels = await Promise.all(products.map(async (p) => ({ product: p, latest: (await readJson<Channel>(bucket, `releases/${p}/channels/latest.json`))?.version ?? null })))
    return json({ products: channels.map((c) => ({ ...c, install: `curl -fsSL https://get.superatom.site/${c.product}/install.sh | sh` })) }, MOVING)
  }
  const [product, ref, file, ...rest] = parts
  if (rest.length) return notFound('No such release.')
  if (!ref) {
    const [chs, vs] = await Promise.all([
      bucket.list({ prefix: `releases/${product}/channels/` }),
      bucket.list({ prefix: `releases/${product}/`, delimiter: '/' }),
    ])
    const versions = vs.delimitedPrefixes.map((p) => p.slice(`releases/${product}/`.length, -1)).filter((v) => v !== 'channels')
    if (!versions.length) return notFound(`There is no product "${product}".`)
    const channels = Object.fromEntries(await Promise.all(chs.objects.map(async (o) => [o.key.slice(`releases/${product}/channels/`.length, -'.json'.length), (await readJson<Channel>(bucket, o.key))?.version ?? null])))
    return json({ product, channels, versions }, MOVING)
  }
  const at = await resolve(bucket, product, ref)
  if (!at) return notFound(`${product} has no version or channel "${ref}".`)
  const cache = at.channel ? MOVING : IMMUTABLE
  const key = `releases/${product}/${at.version}/${file ?? 'manifest.json'}`
  const obj = request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key)
  if (!obj) return notFound(`${product} ${at.version} has no file "${file}".`)
  const headers = new Headers({ 'content-type': typeOf(key), 'cache-control': cache, 'content-length': String(obj.size), 'x-superatom-version': at.version, etag: obj.httpEtag })
  return new Response('body' in obj && request.method === 'GET' ? (obj as R2ObjectBody).body : null, { headers })
}

/** The engine images: the files `docker pull` asks for, as they lie in the bucket (scripts/registry-push.sh). */
export async function handleRegistryHost(request: Request, bucket: R2Bucket | undefined): Promise<Response> {
  const err = (status: number, code: string, message: string) => new Response(JSON.stringify({ errors: [{ code, message }] }), { status, headers: { 'content-type': 'application/json', 'docker-distribution-api-version': 'registry/2.0' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return err(405, 'UNSUPPORTED', 'this registry only serves images')
  if (!bucket) return err(503, 'UNAVAILABLE', 'the registry is not available right now')
  const path = new URL(request.url).pathname
  if (path === '/v2' || path === '/v2/') return new Response('{}', { headers: { 'content-type': 'application/json', 'docker-distribution-api-version': 'registry/2.0' } })
  const m = /^\/v2\/([a-z0-9._/-]+)\/(blobs|manifests)\/([A-Za-z0-9._:-]+)$/.exec(path)
  if (!m || m[1].includes('..')) return err(404, 'NAME_UNKNOWN', 'no such image')
  const key = path.slice(1)
  const obj = request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key)
  if (!obj) return err(404, m[2] === 'blobs' ? 'BLOB_UNKNOWN' : 'MANIFEST_UNKNOWN', `${m[1]}: no ${m[2] === 'blobs' ? 'blob' : 'manifest'} ${m[3]}`)
  const byDigest = m[3].startsWith('sha256:')
  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-length': String(obj.size), etag: obj.httpEtag,
    'cache-control': byDigest ? IMMUTABLE : MOVING, 'docker-distribution-api-version': 'registry/2.0',
    ...(byDigest ? { 'docker-content-digest': m[3] } : {}),
  })
  return new Response('body' in obj && request.method === 'GET' ? (obj as R2ObjectBody).body : null, { headers })
}

/**
 * superatom.site/agent.md — how an AI agent works with Superatom through sacli. It is cli/agent.md, published with each
 * version of sacli, served as the latest version's: what it says always matches the sacli people install.
 */
export async function agentMd(bucket: R2Bucket | undefined): Promise<Response> {
  const ch = bucket ? await readJson<Channel>(bucket, 'releases/sacli/channels/latest.json') : null
  const obj = ch?.version ? await bucket!.get(`releases/sacli/${ch.version}/agent.md`) : null
  if (!obj) return text('The guide for agents is not published yet. How to install: https://superatom.site/install\n', 503)
  return new Response(obj.body, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': MOVING, 'x-superatom-version': ch!.version } })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * superatom.site/install — how to install, upgrade and choose versions of what we ship, with each product's current
 * versions read from the bucket. The page people (and we) come back to; the full reference is docs/releases.md.
 */
export async function installPage(bucket: R2Bucket | undefined): Promise<Response> {
  type Row = { product: string; latest: string | null; versions: string[] }
  let rows: Row[] = []
  if (bucket) {
    const listed = await bucket.list({ prefix: 'releases/', delimiter: '/' }).catch(() => null)
    rows = await Promise.all((listed?.delimitedPrefixes ?? []).map(async (p) => {
      const product = p.slice('releases/'.length, -1)
      const [ch, vs] = await Promise.all([readJson<Channel>(bucket, `releases/${product}/channels/latest.json`), bucket.list({ prefix: `releases/${product}/`, delimiter: '/' })])
      const versions = vs.delimitedPrefixes.map((x) => x.slice(`releases/${product}/`.length, -1)).filter((v) => v !== 'channels').reverse()
      return { product, latest: ch?.version ?? null, versions }
    }))
  }
  const code = (s: string) => `<pre><code>${esc(s)}</code></pre>`
  const products = rows.length
    ? `<table><thead><tr><th>Product</th><th>Latest</th><th>Versions</th></tr></thead><tbody>${rows.map((r) => `<tr><td><strong>${esc(r.product)}</strong></td><td>${r.latest ? `<code>${esc(r.latest)}</code>` : '—'}</td><td>${r.versions.slice(0, 8).map((v) => `<code>${esc(v)}</code>`).join(' ')}${r.versions.length > 8 ? ` <span class="faint">+${r.versions.length - 8} more</span>` : ''}</td></tr>`).join('')}</tbody></table>`
    : `<p class="faint">Nothing is published yet.</p>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Superatom</title><meta name="description" content="Install and upgrade the Superatom CLI and engine">
<style>
:root{--bg:#fff;--surface:#f7f8fa;--ink:#14171c;--muted:#5b6370;--faint:#8a919c;--line:#e3e6eb;--primary:#0f7a6c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a20;--ink:#e8eaee;--muted:#a3aab5;--faint:#737b87;--line:#2a2f38;--primary:#4cc2b0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px;padding-top:20px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:20px 0 6px}p{margin:6px 0}.lead{color:var(--muted);margin-bottom:20px}.faint{color:var(--faint)}a{color:var(--primary)}
pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0}code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
p code,td code,li code{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:0 4px}
table{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:8px 0;display:block;overflow-x:auto}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--surface);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}ul{padding-left:20px;margin:6px 0}nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin:12px 0 0;font-size:14px}
</style></head><body><main>
<h1>Install Superatom</h1>
<p class="lead">The Superatom CLI (<code>sacli</code>) for you or your AI agent, and the engine for your own machines. Everything comes from <code>get.superatom.site</code>.</p>
<p>Handing this to an AI agent? Point it at <a href="/agent.md">superatom.site/agent.md</a>.</p>
<nav><a href="#sacli">Install sacli</a><a href="#upgrade">Upgrade and versions</a><a href="#key">Your key</a><a href="#engine">The engine</a><a href="#versions">What is published</a><a href="#problems">If something fails</a><a href="#publish">Publishing (Superatom team)</a></nav>

<h2 id="sacli">Install sacli</h2>
<p>Needs <a href="https://nodejs.org">Node.js 22</a> or newer, on macOS or Linux.</p>
${code('curl -fsSL https://get.superatom.site/sacli/install.sh | sh')}
<p>A given version instead of the latest:</p>
${code('curl -fsSL https://get.superatom.site/sacli/install.sh | sh -s -- 0.1.0')}
<p>Each version is kept in <code>~/.superatom/sacli/&lt;version&gt;/</code>; the <code>sacli</code> command is a small launcher in <code>~/.local/bin</code> (the installer says if that is not on your PATH). Every download is checked against the published sha256 before it is used.</p>

<h2 id="upgrade">Upgrade and versions</h2>
${code('sacli upgrade            # the latest version\nsacli upgrade 0.1.0      # a given version — also how to go back\nsacli --version')}
<p>The previous versions stay on disk, so moving back is instant. Once a day, in a terminal, sacli tells you when a newer version is out (<code>SACLI_NO_UPDATE_CHECK=1</code> turns that off). Running the install line again also upgrades.</p>

<h2 id="key">Your key</h2>
<p>sacli works through an <strong>agent key</strong>, made in the admin console (the project → Agent keys). The key decides everything sacli may do, and everything it does is in the project's audit history. Save it without it showing on screen:</p>
${code('printf %s "$KEY" | sacli login      # or on a Mac: pbpaste | sacli login\nsacli whoami                        # the project, and what the key may do\nsacli --help')}

<h2 id="engine">The engine</h2>
<p>The engine runs in Docker and is started for a project by sacli, with that project's key:</p>
${code('sacli engine start\nsacli engine status\nsacli engine versions          # what runs, and what versions there are\nsacli engine switch <version>  # or the admin console: Engine → Engine version')}
<p>Its images are served at both <code>registry.superatom.site</code> and <code>registry.superatom.ai</code> — the same images; use whichever your network allows. An installer of its own (<code>get.superatom.site/engine/install.sh</code>) is planned.</p>

<h2 id="versions">What is published</h2>
${products}
<p class="faint">Also as data: <a href="https://get.superatom.site/">get.superatom.site</a> (every product) · <code>get.superatom.site/&lt;product&gt;</code> (its versions) · <code>get.superatom.site/&lt;product&gt;/latest</code> (the latest version's files and their sha256).</p>

<h2 id="problems">If something fails</h2>
<table><thead><tr><th>You see</th><th>Do</th></tr></thead><tbody>
<tr><td><code>needs Node.js 22 or newer</code></td><td>Install or upgrade Node from nodejs.org or your package manager, then run the install line again.</td></tr>
<tr><td><code>sha256 differs</code></td><td>The download was cut short or changed on the way. Run again; if it persists, check what sits between you and the internet (a proxy).</td></tr>
<tr><td><code>is not on your PATH</code></td><td>Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to <code>~/.zshrc</code> or <code>~/.bashrc</code> and open a new terminal.</td></tr>
<tr><td><code>was not installed by the installer</code></td><td>That sacli came another way. Run the install line once; from then on <code>sacli upgrade</code> works.</td></tr>
<tr><td><code>the key was refused</code></td><td>The key was revoked or has expired — ask for a new one.</td></tr>
</tbody></table>

<h2 id="publish">Publishing (Superatom team)</h2>
<ul>
<li><strong>sacli:</strong> raise <code>version</code> in <code>cli/package.json</code> and push to <code>dev</code>. GitHub Actions runs every check, publishes it, makes it latest, and installs it from here as a check. An unchanged version publishes nothing.</li>
<li><strong>Any product:</strong> <code>scripts/release.sh &lt;product&gt; &lt;version&gt; --channel latest &lt;files…&gt;</code> — a version is never overwritten, every file is read back here before <code>latest</code> moves.</li>
<li><strong>Roll back:</strong> <code>scripts/release.sh &lt;product&gt; --move latest &lt;older version&gt;</code>.</li>
<li><strong>The engine:</strong> push to <code>dev</code>; its images are built and pushed by GitHub Actions.</li>
<li>The full reference: <code>docs/releases.md</code> and <code>docs/deploying-the-engine.md</code> in the repository.</li>
</ul>
</main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } })
}
