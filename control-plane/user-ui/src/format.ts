// Lightweight markdown → HTML for answer/log prose. Extracted from App.tsx.

function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
// Light block markdown for answer/section prose: bold/italic/code inline, PLUS a run of lines that start with
// "- " (or "\u2022 ") becomes a real bulleted list. Everything else is plain paragraph text with <br/> line breaks.
// Not full markdown \u2014 just enough that a list-shaped takeaway reads as bullets and key figures can be bolded.
export function renderInlineMd(text: string): string {
  const clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '').replace(/ {2,}/g, ' ')
  const esc = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []
  let para: string[] = [], bullets: string[] = [], numbers: string[] = [], tableRows: string[] = []
  const flushPara = () => { if (para.length) { out.push(para.join('<br/>')); para = [] } }
  const flushBul = () => { if (bullets.length) { out.push(`<ul class="sa-list">${bullets.join('')}</ul>`); bullets = [] } }
  const flushNum = () => { if (numbers.length) { out.push(`<ol class="sa-olist">${numbers.join('')}</ol>`); numbers = [] } }
  const flushTable = () => {   // GFM pipe table: first row = header when row 2 is a `--- | ---` separator
    if (!tableRows.length) return
    const rows = tableRows.map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); tableRows = []
    const isSep = (r: string[]) => r.length > 0 && r.every(c => /^:?-{2,}:?$/.test(c))
    let header: string[] | null = null, body: string[][] = rows
    if (rows.length >= 2 && isSep(rows[1])) { header = rows[0]; body = rows.slice(2) }
    const thead = header ? `<thead><tr>${header.map(c => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>` : ''
    const tbody = `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    out.push(`<table class="sa-mdtable">${thead}${tbody}</table>`)
  }
  const flushAll = () => { flushPara(); flushBul(); flushNum(); flushTable() }
  // A ``` fence becomes a real code block. `explain:` shows the SQL or the one line of logic that decides an
  // answer, and without this the fence markers render as literal text with the query flattened into a
  // paragraph — which is exactly the content the reader opened the explanation to see.
  let fence: string[] | null = null
  for (const ln of esc.split('\n')) {
    const isFence = /^\s*```/.test(ln)
    if (fence !== null) {
      if (isFence) { out.push(`<pre class="sa-code"><code>${fence.join('\n')}</code></pre>`); fence = null }
      else fence.push(ln)
      continue
    }
    if (isFence) { flushAll(); fence = []; continue }
    const isTable = /^\s*\|(.+)\|\s*$/.test(ln)
    const b = ln.match(/^\s*[-\u2022]\s+(.*)/)
    const n = ln.match(/^\s*\d+[.)]\s+(.*)/)   // "1. " / "2) " \u2192 a real numbered list (needs a . or ) right after the digits, so "1338 lanes" is NOT a list item)
    if (isTable) { flushPara(); flushBul(); flushNum(); tableRows.push(ln) }
    else if (b) { flushPara(); flushNum(); flushTable(); bullets.push(`<li>${inlineMd(b[1])}</li>`) }
    else if (n) { flushPara(); flushBul(); flushTable(); numbers.push(`<li>${inlineMd(n[1])}</li>`) }
    else if (ln.trim() === '') { flushAll() }
    else { flushBul(); flushNum(); flushTable(); para.push(inlineMd(ln)) }
  }
  // An unterminated fence still shows its content rather than swallowing it.
  if (fence !== null && fence.length) out.push(`<pre class="sa-code"><code>${fence.join('\n')}</code></pre>`)
  flushAll()
  return out.join('')
}

// A takeaway (answer/caveat) is EITHER a string (a paragraph) OR an array of item strings (a list) — the
// program returns one or the other; the UI decides how it renders. A string, or an array of ONE item, is
// plain text (no bullet). Only an array of MORE THAN ONE item becomes a list.
export function renderAnswerBody(answer: unknown): string {
  if (Array.isArray(answer)) {
    if (answer.length <= 1) return renderInlineMd(String(answer[0] ?? ''))   // single item → plain text, no bullet
    return renderInlineMd(answer.map((it) => `- ${String(it)}`).join('\n'))   // several → a list
  }
  return renderInlineMd(String(answer ?? ''))
}
