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

/** superatom.site/install — the short page for people: install sacli, sign in, upgrade. Kept simple on purpose. */
export async function installPage(bucket: R2Bucket | undefined): Promise<Response> {
  const latest = bucket ? (await readJson<Channel>(bucket, 'releases/sacli/channels/latest.json').catch(() => null))?.version : undefined
  const code = (s: string) => `<pre><code>${esc(s)}</code></pre>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Superatom</title><meta name="description" content="Install the Superatom CLI">
<style>
:root{--bg:#fff;--surface:#f7f8fa;--ink:#14171c;--muted:#5b6370;--line:#e3e6eb;--primary:#0f7a6c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a20;--ink:#e8eaee;--muted:#a3aab5;--line:#2a2f38;--primary:#4cc2b0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:680px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
p{margin:6px 0}.muted{color:var(--muted)}a{color:var(--primary)}
pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0}code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head><body><main>
<h1>Install Superatom</h1>
<p class="muted">The Superatom CLI, <code>sacli</code>${latest ? ` — version ${esc(latest)}` : ''}.</p>

<h2>1. Install</h2>
<p>Needs <a href="https://nodejs.org">Node.js 22</a> or newer, on macOS or Linux.</p>
${code('curl -fsSL https://get.superatom.site/sacli/install.sh | sh')}

<h2>2. Sign in with your key</h2>
<p>Your admin gives you a key. Copy it, then:</p>
${code('pbpaste | sacli login     # macOS; elsewhere: printf %s "$KEY" | sacli login\nsacli whoami')}

<h2>3. Upgrade</h2>
${code('sacli upgrade')}

<p class="muted" style="margin-top:28px">Using an AI agent? Give it <a href="/agent.md">superatom.site/agent.md</a>.</p>
</main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } })
}
