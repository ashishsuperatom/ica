// ── THE PLATFORM MAY NOT SPEAK ONE CUSTOMER'S LANGUAGE ───────────────────────────────────────────────────────
//
// An engine that names a customer's things is not an engine — it is that customer's program with a general
// shape. The names arrive innocently: an example in a tool's instructions, a comment explaining why a fix was
// needed, a test written from the case that exposed the bug. Each is small; together they are a platform that
// cannot be pointed at anybody else, and a customer's figures sitting in a repository.
//
// It is not a rule anyone can be trusted to remember, so it is a check. WHAT IT FORBIDS IS NOT A LIST SOMEONE
// TYPED — that would be the same mistake one level up. It reads the vocabulary of whatever models are actually
// installed on this machine and looks for THOSE words in the platform's own source. Connect a different
// customer and the check defends against that one instead.
//
// WHAT IT CANNOT SEE. A value that lives only at a source — a name in a table the graph never stored — is
// invisible to it. So this is a floor, not a ceiling: it catches the systematic leak, and reading what you
// wrote is still how the rest is caught.

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const STATE = process.env.SUPERATOM_STATE ?? join(homedir(), '.superatom', 'state')
// Where the platform is, from where THIS file is — so the check means the same thing from any directory. Asked
// from the wrong one it read nothing at all and said everything was fine, which is the failure it exists to stop.
const VM = dirname(dirname(fileURLToPath(import.meta.url)))
const PLATFORM = [join(VM, 'apps'), join(VM, 'packages')]
// Generated working directories are not the platform: an agent's workspace holds whatever the agent was given.
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.ica-workspace', '.runs', 'out'])

// WHAT A LEAK ACTUALLY IS: something the platform could not have known without this customer.
//
//   what they CALL a thing   "Project", "person", "currency" — a modeller names things in ordinary words, and the
//                            platform uses those same words for its own reasons. A single such word says nothing
//                            about who the customer is, and flagging it buries the real thing under hundreds.
//   what a thing IS          "Consulting", "F5 Parent", "AUD", a threshold, a list of ids — a VALUE is never the
//                            platform's vocabulary. It came from the customer, it means nothing anywhere else,
//                            and there is no innocent reason for it to appear in the engine.
//   a name of several words  "senior supplier", "valid project" — a phrase is a choice somebody made about this
//                            model, not a word the language handed everyone.
//
// So values and phrases are leaks wherever they appear; a single ordinary word naming a kind of thing is not.
// The line is drawn by WHERE the word came from, which the model itself says — not by a list anyone typed.

/** Every word the models on this machine are made of: what they call their things, and what they hold as settings. */
async function vocabulary(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const projects = await readdir(STATE).catch(() => [])
  for (const p of projects) {
    const file = join(STATE, p, 'db', 'semantic-graph.sqlite')
    if (!(await stat(file).catch(() => null))) continue
    const db = new DatabaseSync(file, { readOnly: true })
    const add = (word: unknown, what: string, is: 'data' | 'naming') => {
      const w = String(word ?? '').trim()
      if (w.length < 3 || /^\d+$/.test(w)) return
      if (is === 'naming' && !/[^\p{L}\p{N}]/u.test(w)) return   // one ordinary word for a kind of thing: not a leak
      if (!found.has(w.toLowerCase())) found.set(w.toLowerCase(), what)
    }
    try {
      for (const r of db.prepare('SELECT id, kind, body FROM g_node').all() as Array<Record<string, string>>) {
        add(r.id, `a ${r.kind} of the model in ${p}`, 'naming')
        const body = JSON.parse(r.body || '{}')
        for (const m of Object.keys(body.measures ?? {})) add(m, `a measure of ${r.id}`, 'naming')
        for (const [a, d] of Object.entries<any>(body.attributes ?? {})) {
          add(a, `an attribute of ${r.id}`, 'naming')
          for (const v of d?.members ?? []) add(v, `a value of ${r.id}.${a}`, 'data')
        }
        for (const l of Object.values(body.members ?? {})) add(l, `a member of ${r.id}`, 'data')
        for (const n of Object.keys(body.names ?? {})) add(n, `a name people use for a ${r.id}`, 'data')
        for (const role of Object.keys(body.arrows ?? {})) add(role, `an arrow of ${r.id}`, 'naming')
      }
      for (const r of db.prepare('SELECT key, value FROM g_setting').all() as Array<Record<string, string>>) {
        add(r.key, `a setting of the model in ${p}`, 'naming')
        // A setting holds whatever it was given — a word, a number, a list of them — so every word in it counts.
        const inside = (v: unknown): void => {
          if (typeof v === 'string') add(v, `the value of the setting "${r.key}"`, 'data')
          else if (Array.isArray(v)) v.forEach(inside)
          else if (v && typeof v === 'object') Object.values(v).forEach(inside)
        }
        try { inside(JSON.parse(r.value)) } catch { add(r.value, `the value of the setting "${r.key}"`, 'data') }
      }
    } finally { db.close() }
  }
  return found
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await files(full)))
    else if (/\.(ts|mts|tsx|mjs|js|md)$/.test(e.name)) out.push(full)
  }
  return out
}

// The platform's own words, claimed once, so an ordinary word a model happens to reuse does not bury the rest.
// A phrase is never claimed: it is always a choice somebody made about one model.
const ours = new Set((await readFile(join(VM, 'scripts', 'platform-words.txt'), 'utf8').catch(() => ''))
  .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')))

const words = await vocabulary()
for (const w of ours) words.delete(w)
if (!words.size) {
  console.log('no model is installed here, so there is no vocabulary to defend against — nothing checked')
  process.exit(0)
}

const said: string[] = []
let read = 0
for (const root of PLATFORM) {
  for (const f of await files(root)) {
    read++
    const text = await readFile(f, 'utf8')
    for (const [word, what] of words) {
      // As a WORD, not as a fragment: "personal" does not name a Person, and "keyed" is not a key.
      const at = new RegExp(`(?<![\\p{L}\\p{N}_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').exec(text)
      if (!at) continue
      const line = text.slice(0, at.index).split('\n').length
      // A word that means something else HERE says so here, where the reason can be read beside it — rather than
      // being excused everywhere, which would hide the next real one.
      if (/platform-word:/.test(text.split('\n')[line - 1] ?? '')) continue
      said.push(`${f}:${line}  "${text.slice(at.index, at.index + word.length)}" — ${what}`)
    }
  }
}

// A check that read nothing passes every time, which is worse than no check: it is a guarantee nobody gave.
if (!read) { console.error(`nothing was read under ${PLATFORM.join(' and ')} — the check cannot say anything, so it does not`); process.exit(1) }
if (!said.length) { console.log(`${read} files say nothing about the ${words.size} words the installed models are made of`); process.exit(0) }
console.error(`The platform speaks one customer's language in ${said.length} place${said.length > 1 ? 's' : ''}.`)
console.error('Say the shape instead: a placeholder a reader cannot mistake for data.\n')
for (const s of said.slice(0, 60)) console.error('  ' + s)
if (said.length > 60) console.error(`  … and ${said.length - 60} more`)
process.exit(1)
