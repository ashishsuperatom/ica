// The default copy of a block: its title, then each section's heading, headline figures and tables as tab-separated
// text, so it pastes into a message as text and into Excel as a table.

const clean = (s: string) => s.replace(/\s*\n+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim()

function tableToText(table: HTMLTableElement) {
  return [...table.rows]
    .filter((r) => r.cells.length > 1 && [...r.cells].some((c) => c.innerText.trim()))
    .map((r) => [...r.cells].map((c) => clean(c.innerText)).join('\t'))
    .join('\n')
}

export function blockToText(root: HTMLElement, heading: string) {
  const out: string[] = [heading]
  const walk = (el: Element) => {
    for (const child of [...el.children] as HTMLElement[]) {
      if (child.dataset.copy === 'skip') continue
      if (child.tagName === 'TABLE') out.push('', tableToText(child as HTMLTableElement))
      else if (child.tagName === 'H2' || child.tagName === 'H3') out.push('', clean(child.innerText))
      else if (child.dataset.copy === 'line') out.push(clean(child.innerText))
      else if (child.tagName === 'DL') [...child.children].forEach((d) => out.push(clean((d as HTMLElement).innerText)))
      else walk(child)
    }
  }
  walk(root)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
