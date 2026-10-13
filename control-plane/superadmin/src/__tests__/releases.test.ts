// get.superatom.site and registry.superatom.site (src/releases.ts) against a bucket laid out as scripts/release.sh and
// scripts/registry-push.sh write it.
import { describe, expect, it } from 'vitest'
import { handleGetHost, handleRegistryHost, installPage, agentMd } from '../releases'

function bucket(files: Record<string, { body: string; type?: string }>): R2Bucket {
  const obj = (key: string) => {
    const f = files[key]
    if (!f) return null
    return { key, size: new TextEncoder().encode(f.body).length, httpEtag: `"${key}"`, httpMetadata: { contentType: f.type }, uploaded: new Date(),
      body: new Response(f.body).body, json: async () => JSON.parse(f.body), text: async () => f.body }
  }
  return {
    head: async (k: string) => { const o = obj(k); return o ? { ...o, body: undefined } : null },
    get: async (k: string) => obj(k),
    list: async ({ prefix = '', delimiter }: { prefix?: string; delimiter?: string }) => {
      const keys = Object.keys(files).filter((k) => k.startsWith(prefix))
      if (!delimiter) return { objects: keys.map((k) => obj(k)), delimitedPrefixes: [], truncated: false }
      const direct = keys.filter((k) => !k.slice(prefix.length).includes(delimiter))
      const subs = [...new Set(keys.filter((k) => k.slice(prefix.length).includes(delimiter)).map((k) => prefix + k.slice(prefix.length).split(delimiter)[0] + delimiter))]
      return { objects: direct.map((k) => obj(k)), delimitedPrefixes: subs, truncated: false }
    },
  } as unknown as R2Bucket
}

const manifest = (version: string) => JSON.stringify({ product: 'sacli', version, at: '2026-10-13T00:00:00Z', files: [{ name: 'sacli.mjs', size: 9, sha256: 'x' }] })
const b = bucket({
  'releases/sacli/0.1.0/manifest.json': { body: manifest('0.1.0') },
  'releases/sacli/0.1.0/sacli.mjs': { body: 'console.1' },
  'releases/sacli/0.2.0/manifest.json': { body: manifest('0.2.0') },
  'releases/sacli/0.2.0/sacli.mjs': { body: 'console.2' },
  'releases/sacli/0.2.0/install.sh': { body: '#!/bin/sh\necho 2' },
  'releases/sacli/0.2.0/agent.md': { body: '# Superatom — for AI agents' },
  'releases/sacli/channels/latest.json': { body: JSON.stringify({ product: 'sacli', channel: 'latest', version: '0.2.0', at: '2026-10-13T00:00:00Z' }) },
  'v2/superatom-engine/manifests/dev': { body: '{"m":1}', type: 'application/vnd.oci.image.manifest.v1+json' },
  'v2/superatom-engine/blobs/sha256:abc': { body: 'layer' },
})
const get = (path: string, method = 'GET') => handleGetHost(new Request(`https://get.superatom.site${path}`, { method }), b)
const reg = (path: string, method = 'GET') => handleRegistryHost(new Request(`https://registry.superatom.site${path}`, { method }), b)

describe('get.superatom.site', () => {
  it('a product installs from /<product>/install.sh — its latest installer; there is no bare /install.sh', async () => {
    const r = await get('/sacli/install.sh')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('echo 2')
    expect(r.headers.get('x-superatom-version')).toBe('0.2.0')
    expect(r.headers.get('cache-control')).toContain('max-age=60')
    expect((await get('/install.sh')).status).toBe(404)
  })
  it('a version is served for ever; a channel as the version it names now', async () => {
    const v = await get('/sacli/0.1.0/sacli.mjs')
    expect(await v.text()).toBe('console.1')
    expect(v.headers.get('cache-control')).toContain('immutable')
    const l = await get('/sacli/latest/sacli.mjs')
    expect(await l.text()).toBe('console.2')
    expect(l.headers.get('x-superatom-version')).toBe('0.2.0')
  })
  it('lists products, a product\'s channels and versions, and a version\'s manifest', async () => {
    const all = await (await get('/')).json() as any
    expect(all.products).toEqual([{ product: 'sacli', latest: '0.2.0', install: 'curl -fsSL https://get.superatom.site/sacli/install.sh | sh' }])
    const p = await (await get('/sacli')).json() as any
    expect(p).toEqual({ product: 'sacli', channels: { latest: '0.2.0' }, versions: ['0.1.0', '0.2.0'] })
    expect(((await (await get('/sacli/latest')).json()) as any).version).toBe('0.2.0')
  })
  it('says what is missing, and refuses writes and odd paths', async () => {
    expect((await get('/nope')).status).toBe(404)
    expect((await get('/sacli/9.9.9/sacli.mjs')).status).toBe(404)
    expect((await get('/sacli/0.1.0/install.sh')).status).toBe(404)
    expect((await get('/sacli/..%2F..%2Fv2/x')).status).toBe(404)
    expect((await get('/sacli/0.1.0/sacli.mjs', 'PUT')).status).toBe(405)
    const h = await get('/sacli/0.1.0/sacli.mjs', 'HEAD')
    expect(h.headers.get('content-length')).toBe('9')
  })
})

describe('registry.superatom.site', () => {
  it('serves what docker pull asks for, as registry.superatom.ai does', async () => {
    expect((await reg('/v2/')).status).toBe(200)
    const m = await reg('/v2/superatom-engine/manifests/dev')
    expect(m.headers.get('content-type')).toBe('application/vnd.oci.image.manifest.v1+json')
    expect(await m.text()).toBe('{"m":1}')
    const blob = await reg('/v2/superatom-engine/blobs/sha256:abc', 'HEAD')
    expect(blob.headers.get('content-length')).toBe('5')
    expect(blob.headers.get('docker-content-digest')).toBe('sha256:abc')
    expect((await reg('/v2/superatom-engine/blobs/sha256:none')).status).toBe(404)
    expect((await reg('/releases/sacli/channels/latest.json')).status).toBe(404)
    expect((await reg('/v2/superatom-engine/manifests/dev', 'DELETE')).status).toBe(405)
  })
})

describe('superatom.site/install', () => {
  it('says how to install, sign in and upgrade, with the latest version', async () => {
    const r = await installPage(b)
    expect(r.headers.get('content-type')).toContain('text/html')
    const html = await r.text()
    for (const s of ['curl -fsSL https://get.superatom.site/sacli/install.sh | sh', 'sacli upgrade', 'sacli login', '/agent.md'])
      expect(html).toContain(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    expect(html).toContain('version 0.2.0')
    // Ours, not theirs: no hosts behind the scenes, no publishing commands, no repository paths.
    for (const s of ['registry.superatom', 'release.sh', 'docs/', 'R2', 'GitHub']) expect(html).not.toContain(s)
  })
  it('shows no version when none is published, and get.superatom.site sends a browser to it', async () => {
    expect(await (await installPage(bucket({}))).text()).not.toContain('version ')
    const r = await handleGetHost(new Request('https://get.superatom.site/', { headers: { accept: 'text/html' } }), b)
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('https://superatom.site/install')
    expect((await get('/')).status).toBe(200)
  })
})

describe('superatom.site/agent.md', () => {
  it('is the latest sacli\'s guide for agents; before any is published it says so', async () => {
    const r = await agentMd(b)
    expect(r.headers.get('content-type')).toContain('text/markdown')
    expect(r.headers.get('x-superatom-version')).toBe('0.2.0')
    expect(await r.text()).toContain('for AI agents')
    expect((await agentMd(bucket({}))).status).toBe(503)
  })
})
