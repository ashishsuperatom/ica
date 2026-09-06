// Can an engine authenticate with NOTHING but CLAUDE_CODE_OAUTH_TOKEN?
//
// That is the fleet question: a machine spawned on demand, never SSH'd into, nobody ever logged in on it.
// The token is set as a deploy secret and that has to be enough.
//
// Tested through createSession — the same path the engine uses — and NOT by driving the `claude` CLI. The
// difference is not academic: this harness spawns the agent in a PTY with a rewritten environment, and it is
// the rewriting that can eat the credential. A CLI test passes while the engine fails.
//
// A clean HOME stands in for a fresh box. No Docker needed: "no credentials anywhere" is a property of the
// environment, not of a container.
//
//   CLAUDE_CODE_OAUTH_TOKEN=… pnpm exec tsx apps/engine/tools/fleet-auth-check.mts
//
// Exits non-zero if the agent could not authenticate.

import { mkdtemp, writeFile, mkdir, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession } from '../ica/index.js'

const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) {
  console.error('CLAUDE_CODE_OAUTH_TOKEN is not set. Mint one with `claude setup-token`.')
  process.exit(2)
}

// A HOME with no credential in it, so a pass cannot be an existing login quietly answering for us.
//
// Two first-run gates are pre-cleared, and NEITHER is auth — both would simply hang a PTY nobody is watching,
// turning a clear result into a timeout:
//   hasCompletedOnboarding       — the welcome flow
//   hasTrustDialogAccepted       — "Do you trust the files in this folder?", asked per working directory
//   bypassPermissionsModeAccepted — the warning shown because the engine spawns with
//                                   --dangerously-skip-permissions; the flag sets the mode, it does not
//                                   accept the dialog
// These matter for the fleet beyond this test: a spawned box has no trusted-directory list either, so an
// engine that only sets the token still stops on the trust prompt. --dangerously-skip-permissions does NOT
// cover it; trust is recorded per project path in ~/.claude.json, so a fresh machine needs it seeded.
// realpath, because on macOS the temp dir is /var/... which is a symlink to /private/var/... — claude records
// trust under the RESOLVED path, so the un-resolved key silently fails to match and the prompt appears anyway.
const home = await realpath(await mkdtemp(join(tmpdir(), 'fleet-auth-')))
const cwd = join(home, 'work')
await mkdir(cwd, { recursive: true })
await writeFile(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, installMethod: 'native', theme: 'light',
  bypassPermissionsModeAccepted: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))

// The environment of a fleet box: the token, and no other way to authenticate. Anything left over from this
// terminal could answer in the token's place and we would learn nothing.
process.env.HOME = home
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_BASE_URL

console.log(`HOME       ${home}  (no credential in it)`)
console.log(`token      …${TOKEN.slice(-8)}  (${TOKEN.length} chars)`)
console.log(`proxy      ${process.env.HTTPS_PROXY ?? 'none'}`)
console.log('')

// A question from the command line runs INSTEAD of the marker check, and its answer is printed in full. The
// marker proves the pipe is connected; a real question proves a real model is on the other end of it — which
// is the thing you actually want to see with your own eyes.
const ASK = process.argv.slice(2).join(' ').trim()
const MARKER = 'FLEET-AUTH-OK'
const session = createSession('claude-code', { cwd, model: 'claude-haiku-4-5-20251001' })

const t0 = Date.now()
let out = ''
try {
  const r = await session.run(ASK || `Reply with exactly: ${MARKER}`, {
    onOutput: (d: string) => { out += d },
  })
  const text = `${r.lastLines ?? ''}\n${out}`
  const ok = ASK ? !!(r.lastLines ?? '').trim() : text.includes(MARKER)
  if (ASK) {
    console.log(`\n${'═'.repeat(60)}\nQUESTION: ${ASK}\n${'═'.repeat(60)}`)
    console.log((r.lastLines ?? '(nothing came back)').trim())
    console.log('═'.repeat(60))
  }
  // "Not logged in" is the specific failure this test exists to catch, so name it rather than reporting a
  // generic miss — that message is what an expired or stripped credential looks like from the outside, and
  // mistaking it for a broken agent is what has cost real time before.
  const notLoggedIn = /not logged in|please run \/login|login expired/i.test(text)

  console.log(`\n${'─'.repeat(60)}`)
  if (ok) {
    console.log(`PASS — authenticated on the token alone in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log('A box with no login, spawned from nothing, can answer.')
  } else if (notLoggedIn) {
    console.log('FAIL — the agent reports it is not logged in.')
    console.log('The token did not reach it. Check that the PTY spawn env keeps CLAUDE_CODE_OAUTH_TOKEN:')
    console.log('ica/claude.ts strips CLAUDE_CODE_* to keep sessions top-level, and the credential shares that prefix.')
  } else {
    console.log('FAIL — no marker in the reply, and no auth error either. Last output:')
    console.log(text.trim().slice(-600))
  }
  // Did a transcript get written? A session that authenticates but saves nothing cannot be --resumed, which
  // is the other half of "the agent works" and has broken here before.
  const projects = await readdir(join(home, '.claude', 'projects')).catch(() => [])
  console.log(`transcript ${projects.length ? `written (${projects.length} project dir)` : 'NONE — --resume will not work'}`)
  console.log('─'.repeat(60))
  process.exit(ok ? 0 : 1)
} finally {
  session.stop()
}
