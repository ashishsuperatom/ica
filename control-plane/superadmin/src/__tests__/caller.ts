// Calling a ProjectDO as the Worker does: only WHO is asking (x-sa-caller) — the DO decides what they hold, from its own
// rows (docs/one-door-plan.md, step 1). So a test person is made real first: on the project's access list, with a role
// holding exactly the capabilities the test means (a built-in one when it matches, else a role of its own).
import { PROJECT_ROLES } from '../../../shared/permissions'

/** How a test reaches the ProjectDO: a path under it (`/roles`) and the request. */
export type ToDO = (path: string, init?: RequestInit) => Promise<Response>

const PLATFORM_ADMIN = 'ashish@superatom.ai'   // auth/tokens.ts SUPERADMIN_EMAILS — the one who may make any role
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** Headers for a person's request: who they are — the actor for the audit, the caller for the decision. */
export const personHeaders = (email: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }),
  'x-sa-caller': JSON.stringify({ kind: 'person', email }),
})

/** `as(email, caps)`: headers for that person, after seating them in the project holding exactly `caps`. */
export function seating(toDO: ToDO) {
  const seated = new Map<string, string>()
  return async (email: string, caps: readonly string[], extra: Record<string, string> = {}): Promise<Record<string, string>> => {
    const want = [...caps].sort().join()
    if (seated.get(email) !== want) {
      let roleId = Object.entries(PROJECT_ROLES).find(([, r]) => same(r.capabilities, caps))?.[0]
      if (!roleId) {
        roleId = `t-${[...want].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`
        const r = await toDO('/roles', { method: 'POST', headers: personHeaders(PLATFORM_ADMIN), body: JSON.stringify({ id: roleId, name: roleId, capabilities: caps, by: PLATFORM_ADMIN }) })
        if (!r.ok) throw new Error(`could not make a role holding ${want}: ${await r.text()}`)
      }
      const g = await toDO('/access', { method: 'POST', body: JSON.stringify({ email, roleId }) })
      if (!g.ok) throw new Error(`could not seat ${email}: ${await g.text()}`)
      seated.set(email, want)
    }
    return { ...personHeaders(email), ...extra }
  }
}

/** The query a test socket opens with, as the clients do: a person's sign-in (?token=…), or a key's socket naming the
 *  person it acts for (?agent=1&person=… — sacli; the key itself comes in the hello and is checked at that person's door). */
export const socketQuery = (hello: Record<string, unknown>): string => {
  if (hello.token) return `?token=${hello.token}`
  const person = typeof hello.key === 'string' ? /^sak_(?:org_[0-9a-z-]{1,64}|[0-9a-f-]{36})_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/.exec(hello.key)?.[1] : null
  return hello.role === 'agent' && person ? `?agent=1&person=${person}` : ''
}
