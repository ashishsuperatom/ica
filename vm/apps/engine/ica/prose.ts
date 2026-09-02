// ── What an agent SAID, with its machinery removed ───────────────────────────
// One function, because the alternative is one per harness and they drift.
//
// An agent's output is prose addressed to a person, mixed with the syntax its model uses to call tools. Which
// syntax depends on the MODEL, not on us: DeepSeek writes `<｜DSML｜tool_calls>`, Anthropic-style models write
// `<invoke name=…>`, others write `<tool_call>` or a fenced JSON block. A harness normally strips its own
// dialect — but a model can emit a dialect its harness has never heard of, and then it travels as ordinary
// text straight to whatever reads it.
//
// That is not hypothetical. Moving the composer from opencode to codex produced narration like:
//
//   "Reading the program and its units to verify assumptions before relying on it.
//    <｜DSML｜tool_calls> <｜DSML｜invoke name="bash"> …"
//
// The narrator has no tools at all — it was imitating syntax it saw in the activity it was fed. Every beat that
// turn was discarded, so a working system looked silent, and only because the composer's brain had changed.
//
// So the rule is here rather than in any one agent: switching harness changes WHICH MODEL thinks, never what
// the system does. Add a dialect to OPENERS and every reader is covered at once.

/** Where prose stops and a tool call begins. Matching one of these means everything after it is machinery. */
const OPENERS: RegExp[] = [
  /<｜[^>]*>/,                          // DeepSeek specials: <｜DSML｜tool_calls>, <｜DSML｜invoke …>, <｜tool▁calls▁begin｜>
  /<\/?(?:antml:)?(?:function_calls|invoke|tool_call|tool_use|parameter)\b/i,   // Anthropic-style / generic XML
  /<\|(?:tool|function|im_start|channel)[^|]*\|>/i,                             // OpenAI-style special tokens
  /^\s*\{"(?:type|name)"\s*:\s*"(?:function_call|tool_use|tool_call)"/m,        // a bare JSON tool call
]

/** The PROSE an agent said. Cuts at the first tool-call marker — the words come before it, the machinery after
 *  — then removes code, paths and diff noise. Safe on text that contains none of it. */
export function agentProse(text: string): string {
  let s = String(text ?? '')

  // Cut at the earliest opener. Truncating rather than excising is deliberate: a streamed tool call is often
  // unterminated, so there is no closing tag to cut back to, and anything after the opener is not for a reader.
  let cut = -1
  for (const re of OPENERS) {
    const m = re.exec(s)
    if (m && (cut < 0 || m.index < cut)) cut = m.index
  }
  if (cut >= 0) s = s.slice(0, cut)

  return s
    .replace(/```[\s\S]*?```/g, ' ')                         // fenced blocks
    .replace(/```[\s\S]*$/g, ' ')                            // an UNCLOSED fence — streamed output ends mid-block
    .replace(/`[^`]*`/g, ' ')                                // inline code
    .split('\n')
    .filter((l) => { const t = l.trim(); return t && !/programs?\/|=>|[{};]\s*$|^\s*[+-]\s|\.(ts|tsx|js|mjs)\b/.test(t) })
    .join('\n')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** True when the text carries tool-call syntax at all — for reporting, so a leak is visible rather than silent. */
export function hasToolMarkup(text: string): boolean {
  const s = String(text ?? '')
  return OPENERS.some((re) => re.test(s))
}
