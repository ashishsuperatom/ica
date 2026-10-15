// ── SETTING A CONNECTOR UP: its steps, each proven before the next (docs/connectors-plan.md 7d) ─────────────────────
//
// A connector carries its own setup — the steps a person takes to connect it, one at a time (progressive: only what is
// needed now is shown). Each step says what to do (with links and things to copy), asks for its few fields, and names a
// CHECK the platform runs — through the same path real reads take — before the next step opens:
//   reach          the source answers at its address (a TCP connection to its host and port, or its URL's)
//   signin         the connector's own test: signed in, a trivial read
//   oauth-app      the organisation has its app with the connector's provider (Sign-in apps)
//   oauth-account  the person connected their own account, and reads with it
//   custom         one of the connector's own, in its code — check(name) — for what only it knows how to prove
// A check that fails says what was wrong and how to fix it: the step's own words for what it knows (`fix`), else the
// common ones below. The last screen of every setup is the same, the flow's own: name it, and see its data.
// A connector with no setup of its own gets one made from its fields (setupOf).

import type { EngineField, EngineManifest } from './contract'

export type SetupCheck =
  | { kind: 'reach'; host?: string; port?: string; url?: string; defaultPort?: number }
  | { kind: 'signin' }
  | { kind: 'oauth-app' }
  | { kind: 'oauth-account' }
  /** One of the connector's own (its bridge's check(name): what it found, in words — or an error saying what is wrong). */
  | { kind: 'custom'; name: string }
export interface SetupStep {
  id: string
  title: string
  /** What to do, in words. [text](https://…) is a link; {field} is the value given for that field. Blank lines part paragraphs. */
  say: string
  /** The fields asked in this step (by name). */
  fields?: string[]
  /** Text to copy (a command, an address). */
  copy?: { label: string; value: string }[]
  check?: SetupCheck
  /** What to say when its check fails: the first whose pattern (a regular expression, case ignored) the error matches. */
  fix?: { when: string; say: string }[]
  /** Who takes it: the one setting the connection up (default), or each person who reads it (their own account). */
  who?: 'setup' | 'person'
}

const KINDS = ['reach', 'signin', 'oauth-app', 'oauth-account', 'custom']

/** A manifest's setup checked: its steps' fields exist, every field is asked somewhere, its checks are known. */
export function checkSetup(m: EngineManifest): string[] {
  const steps = m.setup
  if (steps === undefined) return []
  const bad: string[] = []
  if (!Array.isArray(steps) || !steps.length) return ['setup is a list of steps']
  const asked = new Set<string>()
  for (const s of steps) {
    if (!s?.id || !s?.title || typeof s.say !== 'string') { bad.push('each setup step has an id, a title and what it says'); continue }
    for (const f of s.fields ?? []) { if (!m.fields.some((x) => x.name === f)) bad.push(`setup step ${s.id}: there is no field ${f}`); asked.add(f) }
    if (s.check && !KINDS.includes(s.check.kind)) bad.push(`setup step ${s.id}: check is ${KINDS.join(', ')}`)
    if (s.check?.kind === 'custom' && !/^[a-z][a-z0-9-]*$/.test((s.check as any).name ?? '')) bad.push(`setup step ${s.id}: a custom check names one of its connector's checks`)
    for (const x of s.fix ?? []) { try { new RegExp(x.when, 'i') } catch { bad.push(`setup step ${s.id}: fix "${x.when}" is not a pattern`) } }
  }
  for (const f of m.fields) if (!asked.has(f.name)) bad.push(`setup: field ${f.name} is asked in no step`)
  return bad
}

const isWho = (f: EngineField) => /^(user|username|login|account|email)$/i.test(f.name)
const controls = (fields: EngineField[]) => new Set(fields.flatMap((f) => Object.keys(f.when ?? {})))

/** A connector's setup: its own, or one made from its fields — where it is (reached), then signing in (tested); for one
 *  people sign in to, the organisation's app, then each person's account. */
export function setupOf(m: Pick<EngineManifest, 'title' | 'kind' | 'fields' | 'identity' | 'setup'> & { oauth?: { provider: string } }): SetupStep[] {
  if (m.setup?.length) return m.setup
  const steps: SetupStep[] = []
  const personOnly = !m.identity.includes('shared')
  if (m.identity.includes('person-oauth') && m.oauth) {
    steps.push({ id: 'app', title: `Your organisation's ${m.oauth.provider} app`, say: `People sign in to ${m.title} with their own ${m.oauth.provider} account, through your organisation's own app with ${m.oauth.provider}. An organisation admin sets it once.`, check: { kind: 'oauth-app' } })
  }
  const ctl = controls(m.fields)
  const signIn = m.fields.filter((f) => f.type === 'secret' || isWho(f) || ctl.has(f.name) || f.when)
  const where = m.fields.filter((f) => !signIn.includes(f))
  const host = where.find((f) => /^(host|hostname|server)$/i.test(f.name)), port = where.find((f) => /^port$/i.test(f.name)), url = where.find((f) => f.type === 'url')
  if (where.length) steps.push({ id: 'where', title: 'Where it is', say: `Where ${m.title} answers, as the engine will reach it.`, fields: where.map((f) => f.name),
    ...(host ? { check: { kind: 'reach' as const, host: host.name, ...(port ? { port: port.name } : {}) } } : url ? { check: { kind: 'reach' as const, url: url.name } } : {}) })
  if (signIn.length) steps.push({ id: 'signin', title: 'Sign in', say: `How ${m.title} lets the engine in. An account that may only read is best.`, fields: signIn.map((f) => f.name), check: { kind: 'signin' } })
  else if (!personOnly) steps.push({ id: 'try', title: 'Try it', say: `The engine opens ${m.title} with what you gave, and reads from it.`, check: { kind: 'signin' } })
  if (m.identity.includes('person-oauth') && m.oauth) steps.push({ id: 'account', title: 'Your own account', say: `Connect your own ${m.oauth.provider} account: ${m.title} is read with it, and what you see is what it may see.`, who: 'person', check: { kind: 'oauth-account' } })
  return steps
}

// The common reasons a check fails, and what to do — said in a person's words; {field} filled from what they gave.
const COMMON: { when: RegExp; say: string }[] = [
  { when: /ENOTFOUND|EAI_AGAIN|getaddrinfo|not known|no such host/i, say: 'No computer answers to that name. Check its spelling — and that it is the address as seen from where the engine runs, not "localhost" unless the engine runs on that same machine.' },
  { when: /ECONNREFUSED|connection refused/i, say: 'The computer answers, but nothing listens on that port. Check the port, and that the service is running.' },
  { when: /ETIMEDOUT|timed? ?out|did not answer/i, say: 'Nothing came back — a firewall is probably dropping the connection. Let the engine\'s machine in (its allow-list or security group), then check again.' },
  { when: /password authentication failed|login failed|access denied|authentication failed|invalid (user|credentials|password)|wrong password|ORA-01017|401|unauthori[sz]ed/i, say: 'The sign-in was refused: the user name or the password (or token) is not right, or that user may not sign in from here.' },
  { when: /does not exist|unknown database|cannot open database|ORA-12514|service .* not known/i, say: 'It answers, but there is no database (or service) by that name. Check its name — names are often case-sensitive.' },
  { when: /permission denied|not authori[sz]ed|insufficient privilege|403|forbidden/i, say: 'Signed in, but this user may not read. Give it read access (SELECT on the tables, or a read-only role).' },
  { when: /SSL|TLS|certificate|self.signed|handshake/i, say: 'The secure connection did not work. Try the other SSL setting, or ask for the server\'s certificate to be trusted.' },
]

/** What to tell the person when a step's check failed with this error. */
export function fixFor(step: SetupStep | undefined, error: string, values: Record<string, unknown> = {}): string {
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => (values[k] !== undefined && values[k] !== '' ? String(values[k]) : `the ${k}`))
  for (const f of step?.fix ?? []) if (new RegExp(f.when, 'i').test(error)) return fill(f.say)
  for (const f of COMMON) if (f.when.test(error)) return fill(f.say)
  return 'Check what this step asks for, then check again. The exact reason is shown below.'
}
