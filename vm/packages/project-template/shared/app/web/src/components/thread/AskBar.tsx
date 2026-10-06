// A typed question at the foot of the thread, answered in prose by the composer and shown as a new block under the
// block it was asked from — the nearest block above the active leaf that is a state. On the home page, with no block
// yet, a question starts a thread of its own, and its words pick the agent that answers. Enter sends, Shift+Enter
// breaks a line; one reading at a time per thread.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { useThread } from '@/runtime/thread'

export default function AskBar() {
  const { blocks, say, saying } = useThread()
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const from = [...blocks].reverse().find((n) => n.kind !== 'said' && n.question.focus !== 'about')
  const fromTitle = from?.answer?.title ?? from?.placeholder ?? from?.question.focus ?? ''
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px` }, [text])
  const send = () => { const t = text.trim(); if (!t || saying) return; say(t); setText('') }
  return (
    <div className="sa-askbar" data-copy="skip">
      <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); send() }}>
        <div className="sa-askbar__field">
          <button type="button" className="sa-icon-btn sa-askbar__plus" disabled aria-label="Attach" title="Attach — not yet">
            <Icon icon="lucide:plus" />
          </button>
          <textarea
            ref={box} className="sa-askbar__input" rows={1} value={text} disabled={saying || !from}
            placeholder={saying ? 'Working on it…' : from ? 'Ask about these numbers…' : 'Ask a question…'}
            aria-label="Ask about these numbers"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          />
          <button type="submit" className="sa-icon-btn sa-askbar__send" disabled={saying || !text.trim()} aria-label="Ask" title="Ask (Enter)">
            <Icon icon={saying ? 'lucide:loader' : 'lucide:arrow-up'} />
          </button>
        </div>
        {from && <div className="sa-askbar__hint truncate" title={fromTitle}>{saying ? 'reading…' : 'asked from'} <b>{fromTitle}</b></div>}
      </form>
    </div>
  )
}
