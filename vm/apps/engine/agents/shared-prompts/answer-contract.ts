// ── THE ANSWER CONTRACT — stated once, read by every agent that produces an answer ───────────────────────
//
// WHY THIS FILE EXISTS. This text lived twice, verbatim, in composer/generate-system.ts and
// analyst/generate-system.ts — eighteen identical lines in both. Two copies of a rule is how one gets fixed
// and the other does not, and it had already gone wrong: both copies told the agent that a column's `entity`
// "defaults to the table name". No such default exists, and none CAN exist — the renderer receives a column as
// {label, entity?, unit?, …} and never sees a table name, so there is nothing to fall back to. An agent read
// that, reasonably omitted `entity`, and shipped a table whose cells carried ids that could not be opened. It
// had followed the instruction faithfully; the instruction was wrong, in two places at once.
//
// So the contract has one home. The generators import it; SYSTEM.md and system/base.md are built from it.
// Changing it here changes it everywhere, and the two can no longer drift apart.
//
// KEEP IT TRUE. Every clause here is a promise the RENDERER has to keep (control-plane/user-ui/src/format.ts)
// and the EXAMPLE templates have to demonstrate. A clause none of them implements is worse than no clause:
// the agent obeys it, and the failure surfaces as a dead affordance nobody can trace back to a sentence.

/** The view-model a program's final UI unit returns. */
export const ANSWER_SHAPE = `## The answer your program returns
Its final UI unit produces the view-model the card renders. EVERY field is one of these, and each is the type
shown — a field in another shape does not render, and one that is an object where text is expected takes the
whole card down:

\`\`\`
{ "status": "answered" | "unknowable" | "uncertain",
  "category": "simple_lookup | complex_lookup | comparison | causal | counterfactual | analysis",
  "answer":   "the key takeaway — a STRING, or an array of short strings. Not the table's rows again.",
  "headline": { "label": "what the number IS", "display": "the number, short, with its unit", "value": <raw number> },
  "period":   "the time window IN PLAIN WORDS — a string",
  "periods":  [ { "label": "a compared scope", "detail": "its exact range" } ],   ← use this for a COMPARISON
  "scope":    "the non-time filters you applied — a string",
  "sections": [ { "kind": "table", "title": "…", "columns": [...], "rows": [[...]] } ],
  "caveat":   "a string, or an array of short strings" }
\`\`\``

/** How cells and columns are shaped. The id/kind dependency is stated where the id is, because that is where
 *  the agent is standing when it decides. */
export const ANSWER_TABLE = `### A table
YOU decide how each figure reads — you are the only thing holding both the raw value and what it means.

MOST CELLS ARE PLAIN: a number is a number, a name is a string. That is what sorts, right-aligns and totals,
and it is the default. Wrap one only to carry what the value itself cannot:
- \`{"value": <the name>, "id": <its id>}\` — this cell NAMES something the reader can open on its own. If you
  have the id, send it; it is the only handle on that thing. The KIND is said ONCE, on the column
  (\`entity\`) — opening a cell means asking for that kind by that id, so an id with no kind opens nothing,
  and a kind with no id opens nothing either. Put \`entity\` on a CELL only when one column mixes kinds;
  repeating the column's own kind on every row is bulk that says nothing new.
- \`{"value": <the number>, "display": "<how it reads>"}\` — only when the wording varies ROW BY ROW, such as a
  column holding several currencies. A whole column's formatting belongs on the column.

HOW A NUMBER READS is said once on the COLUMN, never per row. Money, hours and percentages are the same thing —
a number with a unit and a precision — so there is one set of keys and money is simply \`unit: "AUD"\`:
\`{"label": "<heading>", "entity": "<what kind of thing this column names — required for its cells to be openable>", "unit": "<AUD | h | % | kg …>",
"decimals": <how precise the figure really is>, "scale": "compact" (4.16 M rather than 4,160,000),
"good": "high"|"low" (which direction is favourable, so the figure can be toned — omit it and nothing is
coloured), "mid": <the line good turns on, default 0>, "bar": true (shade the cell by magnitude)}\`.
Send the number as it should READ: a percentage is 83.4, not 0.834. And say \`decimals\` — 686.76895 hours is not
five-decimal data, and without it the figure is printed at whatever precision the arithmetic happened to leave.`
