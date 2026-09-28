// Who is signed in, read from the sa-token's JWT payload — the base64url middle segment, decoded, never verified
// (the hub verifies; this only names the person). The token goes nowhere from here.

import { config } from './client'

export interface Viewer { name: string; email?: string; id?: string; initials: string }

const initialsOf = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]).toUpperCase()
}

function payloadOf(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const json = decodeURIComponent(Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
    const v: unknown = JSON.parse(json)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch { return null }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function viewer(): Viewer {
  if (config.mock) return { name: 'Mock viewer', initials: 'MV' }
  let token = ''
  try { token = localStorage.getItem('sa-token') ?? '' } catch { /* storage blocked */ }
  const p = token ? payloadOf(token) : null
  const email = str(p?.email)
  const id = str(p?.userId) ?? str(p?.sub)
  const name = str(p?.name) ?? email ?? id ?? 'Signed in'
  return { name, email, id, initials: initialsOf(name === email && email ? email.split('@')[0] : name) }
}
