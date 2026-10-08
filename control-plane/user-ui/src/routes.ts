// THE USER APP'S ADDRESSES — one table, read and written here and nowhere else:
//   /                      home
//   /<page>                the app's own pages (about, agents, activity, connections, profile, settings)
//   /c/<session>           a session
//   /a/<agent>[/<start>]   an agent's view, at one of its starting points
//   /<slug>                a place on the project's map (its agent's view)
// The view's STATE rides in the query (?v=): it says what is on screen, not where one is. A place's slug is never one of
// the app's own words (platform-types RESERVED_SLUGS — the map refuses them), so no address means two things.
//
// Inside the app an address is a path: '' (home), '<session>', 's/<agent>[/<start>]' or 'p/<slug>', with the page apart.

import { APP_PAGES, RESERVED_SLUGS, slugOf, type ProjectMap } from '@superatom/platform-types'

export type Page = (typeof APP_PAGES)[number]
export const isPage = (p: string): p is Page => (APP_PAGES as readonly string[]).includes(p)

/** Where an address points: the path inside the app, and the page when it is one of the app's own. */
export function readRoute(pathname: string): { path: string; page?: Page } {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'u') parts.shift()   // the app served under /u (a worker's own host): the same addresses beneath it
  const [a, b, c] = parts
  if (!a) return { path: '' }
  if (a === 'c' && b && /^[\w-]+$/.test(b)) return { path: b }
  if (a === 'a' && b && /^[\w-]+$/.test(b)) return { path: `s/${b}${c && /^[\w-]+$/.test(c) ? `/${c}` : ''}` }
  if (parts.length === 1 && isPage(a)) return { path: '', page: a }
  if (parts.length === 1 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a) && !RESERVED_SLUGS.includes(a)) return { path: `p/${a}` }
  return { path: '' }
}

/** The place an agent has on the map, if it has one. */
export const placeOf = (map: ProjectMap | null, agent: string) => map?.sections.flatMap((s) => s.items).find((i) => i.agent === agent) ?? null
/** The agent a place opens, if the map has the place. */
export const agentAt = (map: ProjectMap | null, slug: string) => map?.sections.flatMap((s) => s.items).find((i) => slugOf(i) === slug)?.agent ?? null

/** The address of a path inside the app: an agent on the map at its place's own address. */
export function addressOf(path: string, map: ProjectMap | null): string {
  if (!path) return '/'
  if (path.startsWith('p/')) return `/${path.slice(2)}`
  const m = /^s\/([\w-]+)(?:\/([\w-]+))?$/.exec(path)
  if (m) { const place = !m[2] ? placeOf(map, m[1]) : null; return place ? `/${slugOf(place)}` : `/a/${m[1]}${m[2] ? `/${m[2]}` : ''}` }
  return `/c/${path}`
}

/** A page's address. */
export const pageAddress = (page: string) => (page === 'home' ? '/' : `/${page}`)
