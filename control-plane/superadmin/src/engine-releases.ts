// The engine versions there are (docs/deploying-the-engine.md): each name in the registry bucket — a build's own
// (dev-<date>-<commit>) and the channels (dev, prod) — with the digest it names and when it was published. Read by a
// project's DO (its Engine version page) and by the fleet's list of engines.

export const ENGINE_IMAGE = 'superatom-engine'
export interface EngineRelease { tag: string; digest: string; at: string }

/** Newest first, at most 40 names. Empty, with the reason, when the bucket is not bound. */
export async function listEngineReleases(bucket: R2Bucket | undefined): Promise<{ releases: EngineRelease[]; problem?: string }> {
  if (!bucket) return { releases: [], problem: 'the registry bucket is not bound to the platform (wrangler.jsonc r2_buckets REGISTRY)' }
  const prefix = `v2/${ENGINE_IMAGE}/manifests/`
  const listed = await bucket.list({ prefix, limit: 1000 })
  const tags = listed.objects.filter((o) => !o.key.slice(prefix.length).startsWith('sha256:'))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime()).slice(0, 40)
  const releases = await Promise.all(tags.map(async (o) => {
    const body = await (await bucket.get(o.key))?.arrayBuffer()
    const digest = body ? `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((b) => b.toString(16).padStart(2, '0')).join('')}` : ''
    return { tag: o.key.slice(prefix.length), digest, at: o.uploaded.toISOString() }
  }))
  return { releases: releases.filter((x) => x.digest) }
}

/** A version's build (its own name, never a channel) — what a person reads it by, with when it was published. */
export const buildOf = (releases: EngineRelease[], digest: string | null | undefined) =>
  (digest ? releases.find((x) => x.digest === digest && /-\d{8}-[0-9a-f]+$/.test(x.tag)) : undefined) ?? null
