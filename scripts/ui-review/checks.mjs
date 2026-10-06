// What is checked on every page, at every width — the mistakes that kept reaching the person:
//
//   clipped      a control (button, link, field) cut off by a container that hides its overflow
//   overflow     the page scrolls sideways
//   flush        text pressed against the inner edge of a card, panel or dialog (no padding between)
//   overlap      a control lying over another control
//   sideways     a box that scrolls sideways though it is not a table, code or columns (its content is too wide)
//
// Run inside the page (its source is sent as an expression); returns plain data.

export const CHECKS = String(function checks() {
  const issues = []
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 }
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 50)
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` “${t}”` : ''}`
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }

  // overflow
  const sw = document.documentElement.scrollWidth, iw = window.innerWidth
  if (sw > iw + 1) issues.push({ kind: 'overflow', what: `the page is ${sw - iw}px wider than the window`, at: { x: iw, y: 0, w: sw - iw, h: 40 } })

  // clipped: partly outside an ancestor that hides horizontal overflow (a sideways scroller is meant to)
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')].filter(visible)
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a)
      const hides = ['hidden', 'clip'].includes(s.overflowX)
      if (!hides) continue
      const ar = a.getBoundingClientRect()
      // partly or wholly past a side: either way the person cannot reach all of it
      const cut = r.right > ar.right + 1 || r.left < ar.left - 1
      if (cut) issues.push({ kind: 'clipped', what: `${name(el)} is ${r.left >= ar.right - 1 || r.right <= ar.left + 1 ? 'hidden' : 'cut off'} by ${name(a).split(' ')[0]}`, at: rectOf(el) })
      break
    }
  }

  // sideways: a box that scrolls sideways though it is not a table, code or a set of columns — content wider than its place
  const scrollers = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.scrollWidth <= el.clientWidth + 2 || !visible(el)) return false
    const ox = getComputedStyle(el).overflowX
    if (ox !== 'auto' && ox !== 'scroll') return false
    return !el.closest('table, pre, code, .sa-records, .sa-section__scroll, .sa-cols, .sa-table-wrap, [data-scroll-x], .xterm, .sa-explorer__grid, .sa-versions__line, .sa-crumbs')
  })
  for (const el of scrollers.slice(0, 10)) issues.push({ kind: 'sideways', what: `${name(el).split(' ')[0]} scrolls sideways: its content is ${el.scrollWidth - el.clientWidth}px wider than it`, at: rectOf(el) })

  // flush: a line of text closer than 6px to the inner edge of its card, panel or dialog
  const frames = [...document.querySelectorAll('.sa-card, .sa-col, .sa-dialog__box, .sa-section, .card')].filter(visible)
  const seen = new Set()
  for (const f of frames) {
    const fr = f.getBoundingClientRect(), fs = getComputedStyle(f)
    const inner = { l: fr.left + parseFloat(fs.borderLeftWidth), r: fr.right - parseFloat(fs.borderRightWidth) }
    const walker = document.createTreeWalker(f, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) })
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || seen.has(el) || !visible(el)) continue
      // a nearer frame decides for its own text; tables and things marked to bleed run edge to edge by design
      if (el.closest('.sa-card, .sa-col, .sa-dialog__box, .sa-section, .card') !== f) continue
      if (el.closest('table, [data-bleed], .sa-records, .sa-cols__edges, svg')) continue
      const range = document.createRange(); range.selectNodeContents(n)
      const tr = range.getBoundingClientRect()
      if (!tr.width || tr.right < inner.l || tr.left > inner.r) continue   // out of the frame altogether is clipping's business
      if ((tr.left - inner.l < 6 && tr.left >= inner.l - 1) || (inner.r - tr.right < 6 && tr.right <= inner.r + 1)) { seen.add(el); issues.push({ kind: 'flush', what: `“${n.textContent.trim().slice(0, 40)}” touches the edge of ${name(f).split(' ')[0]}`, at: { x: Math.round(tr.left), y: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) } }) }
    }
  }

  // overlap: two controls covering each other (not one inside the other)
  const shownAt = (el, x, y) => {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const st = getComputedStyle(a)
      if (st.overflowX === 'visible' && st.overflowY === 'visible') continue
      const r = a.getBoundingClientRect()
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
    }
    return true
  }
  const boxes = controls.slice(0, 400).map((el) => [el, el.getBoundingClientRect()])
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, ra] = boxes[i], [b, rb] = boxes[j]
    if (a.contains(b) || b.contains(a)) continue
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
    if (!(w > 4 && h > 4 && w * h > 0.3 * Math.min(ra.width * ra.height, rb.width * rb.height))) continue
    // only where both are in view: a control scrolled out of its container (under a pinned footer, past a panel's end) is not lying over anything
    const x = Math.max(ra.left, rb.left) + w / 2, y = Math.max(ra.top, rb.top) + h / 2
    if (!shownAt(a, x, y) || !shownAt(b, x, y)) continue
    issues.push({ kind: 'overlap', what: `${name(a)} overlaps ${name(b)}`, at: rectOf(a) })
  }
  return issues.slice(0, 60)
})
