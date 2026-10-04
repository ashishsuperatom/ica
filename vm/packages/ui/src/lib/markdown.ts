// Markdown from the reader, as HTML the page can show: no raw HTML passes (a tag in the text is shown as text),
// and a link goes only where a link should. Everything else — headings, lists, tables, emphasis, code — is marked's.

import { marked, type Tokens } from 'marked'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const safeHref = (href: string) => (/^(https?:|mailto:|#|\/|\.\/)/i.test(href.trim()) ? href : null)

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) { return escape(token.raw) },
    link(token: Tokens.Link) {
      const href = safeHref(token.href)
      const text = this.parser.parseInline(token.tokens)
      return href ? `<a href="${escape(href)}" rel="noopener noreferrer" target="_blank"${token.title ? ` title="${escape(token.title)}"` : ''}>${text}</a>` : text
    },
    image(token: Tokens.Image) { return escape(token.text || token.href) },
  },
})

export function markdownToHtml(md: string): string {
  const out = marked.parse(md, { async: false })
  return typeof out === 'string' ? out : ''
}
