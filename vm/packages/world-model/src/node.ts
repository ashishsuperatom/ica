// The journal and the cache as files — for running a model alone on one machine (Node). Superatom does not use these:
// its journal is the platform's, its cache the engine's.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Cache, Entry, Journal } from './ports.js'

/** A journal in one file, a line per entry, written before append resolves. One process writes it at a time. */
export function fileJournal(dir: string): Journal {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'journal.jsonl')
  if (!existsSync(path)) writeFileSync(path, '')
  const all = (): Entry[] => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry)
  let count = all().length
  return {
    async append(batch) {
      const lines = batch.map((e) => JSON.stringify({ ...e, seq: ++count })).join('\n')
      if (lines) appendFileSync(path, lines + '\n')
      return count
    },
    async read(since, limit = 1000) {
      const slice = all().slice(since, since + limit)
      return { entries: slice, next: since + slice.length }
    },
  }
}

/** A cache of files, each written whole (a temporary file, then renamed), so a crash never leaves half of one. */
export function fileCache(dir: string): Cache {
  mkdirSync(dir, { recursive: true })
  const file = (key: string) => join(dir, `${key.replace(/[^\w.-]/g, '_')}.json`)
  return {
    async get<T>(key: string) { return existsSync(file(key)) ? (JSON.parse(readFileSync(file(key), 'utf8')) as T) : null },
    async put(key, value) { const f = file(key); writeFileSync(`${f}.tmp`, JSON.stringify(value)); renameSync(`${f}.tmp`, f) },
  }
}
