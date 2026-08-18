// ── Central log + error channel ───────────────────────────────────────────────
// ONE place the engine reports to, so a failure BUBBLES to a visible channel instead of vanishing into a
// local `catch {}`. A bounded in-memory ring buffer (surfaced in the admin inspector's Logs view) plus the
// console. Safe file readers live here too: they NEVER assume a file exists and NEVER throw — a missing file
// is normal (returns the fallback, silently), any OTHER failure is logged and the fallback returned. So a
// caller can load a file without a guard and the engine keeps running whether or not it's there.

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

export type LogLevel = 'info' | 'warn' | 'error'
export interface LogEntry { at: number; level: LogLevel; scope: string; msg: string; detail?: string }

const RING = 500
const buffer: LogEntry[] = []

function push(level: LogLevel, scope: string, msg: string, detail?: string): LogEntry {
  const e: LogEntry = { at: Date.now(), level, scope, msg, detail }
  buffer.push(e)
  if (buffer.length > RING) buffer.shift()
  const line = `[${scope}] ${msg}${detail ? ' — ' + detail : ''}`
  if (level === 'error') console.error('✗ ' + line)
  else if (level === 'warn') console.warn('! ' + line)
  else console.log(line)
  return e
}

const detailOf = (err: unknown): string | undefined =>
  err == null ? undefined : (err as any)?.message ?? String(err)

export const log = {
  info: (scope: string, msg: string, detail?: string) => push('info', scope, msg, detail),
  warn: (scope: string, msg: string, detail?: unknown) => push('warn', scope, msg, detailOf(detail)),
  error: (scope: string, msg: string, err?: unknown) => push('error', scope, msg, detailOf(err)),
  /** Recent entries, newest first. Optionally filter by level and cap the count. */
  recent: (opts: { level?: LogLevel; limit?: number } = {}): LogEntry[] => {
    const out = opts.level ? buffer.filter((e) => e.level === opts.level) : buffer
    return out.slice(-(opts.limit ?? 200)).reverse()
  },
  /** Counts by level over the whole buffer — for a health glance. */
  counts: (): Record<LogLevel, number> => {
    const c: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 }
    for (const e of buffer) c[e.level]++
    return c
  },
}

const isMissing = (e: any): boolean => e?.code === 'ENOENT'   // expected-absent — not a real error

/** Read a text file; missing → fallback (silent); any other failure → logged + fallback. Never throws. */
export async function readTextSafe(path: string, fallback: string | null = null, scope = 'fs'): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (e) { if (!isMissing(e)) log.error(scope, `read failed: ${path}`, e); return fallback }
}

/** Read + parse JSON; missing or bad JSON → fallback (bad JSON is logged). Never throws. */
export async function readJsonSafe<T = any>(path: string, fallback: T | null = null, scope = 'fs'): Promise<T | null> {
  const text = await readTextSafe(path, null, scope)
  if (text == null) return fallback
  try { return JSON.parse(text) as T }
  catch (e) { log.error(scope, `bad JSON: ${path}`, e); return fallback }
}

/** Sync text read for boot-time paths — same never-throw contract. */
export function readTextSafeSync(path: string, fallback: string | null = null, scope = 'fs'): string | null {
  try { return readFileSync(path, 'utf8') }
  catch (e) { if (!isMissing(e)) log.error(scope, `read failed: ${path}`, e); return fallback }
}
