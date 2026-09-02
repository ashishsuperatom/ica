// ── One reader's view, whatever model produced the text ──────────────────────
//   pnpm exec tsx vm/apps/engine/test/prose.test.mts
//
// Switching harness must change WHICH MODEL thinks, never what the system does. The thing that breaks that is
// tool-call syntax: each model has its own, a harness strips only its own, and whatever it misses travels as
// plain text to every reader. Moving the composer to codex silently discarded an entire turn's narration this
// way. Each dialect below is one line in OPENERS; this asserts every one of them yields the same clean prose.
import { agentProse, hasToolMarkup } from '../ica/prose.js'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

const SAID = 'Reading the program and its units to verify assumptions before relying on it.'

// Verbatim from this session's logs — the one that discarded every beat of a turn.
const DEEPSEEK = `${SAID} <｜DSML｜tool_calls> <｜DSML｜invoke name="bash"> <｜DSML｜parameter name="command" string="true">cd /Users/amigoz/broken`
const ANTHROPIC = `${SAID}\n<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>`
const GENERIC   = `${SAID} <tool_call>{"name":"query","arguments":{}}</tool_call>`
const OPENAI    = `${SAID} <|tool_calls_begin|> something`
const JSONCALL  = `${SAID}\n{"type":"function_call","name":"bash"}`
const FENCED    = `${SAID}\n\`\`\`sql\nSELECT COUNT(*) FROM job\n\`\`\``
const UNCLOSED  = `${SAID}\n\`\`\`sql\nSELECT COUNT(*) FROM job`          // streamed output, cut mid-block

for (const [dialect, raw] of Object.entries({ DEEPSEEK, ANTHROPIC, GENERIC, OPENAI, JSONCALL, FENCED, UNCLOSED })) {
  const out = agentProse(raw)
  check(`${dialect}: yields exactly the prose`, out === SAID, out === SAID ? '' : JSON.stringify(out).slice(0, 90))
}

// Prose that merely TALKS about tools must survive — over-stripping is its own failure.
const INNOCENT = 'I ran the query and the totals reconcile; the invoke count looks right.'
check('prose mentioning tools is untouched', agentProse(INNOCENT) === INNOCENT, JSON.stringify(agentProse(INNOCENT)).slice(0, 80))
check('plain prose is untouched', agentProse(SAID) === SAID)
check('empty input is safe', agentProse('') === '' && agentProse(undefined as any) === '')

// The detector is what makes a leak visible instead of silent.
check('hasToolMarkup spots a dialect', hasToolMarkup(DEEPSEEK) && hasToolMarkup(ANTHROPIC))
check('hasToolMarkup is quiet on prose', !hasToolMarkup(INNOCENT))

console.log(failed ? `\n${failed} failed` : '\nevery dialect reads the same')
process.exit(failed ? 1 : 0)
