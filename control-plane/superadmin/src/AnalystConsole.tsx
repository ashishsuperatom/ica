// The analyst, live: ask it a question and watch it build the program and answer it. Unlike the user UI (which only
// watches), an admin drives it here; one session per page, so follow-ups carry on from the last answer.
import { useRef, useState } from 'react'
import { Notice } from '@superatom/ui'
import type { Hub } from './hub'
import { AgentPage, AskLine, useAgentTerminal } from './AgentTerminal'

export function AnalystConsole({ hub }: { hub: Hub }) {
  const sid = useRef(crypto.randomUUID())
  const [answer, setAnswer] = useState('')
  const t = useAgentTerminal(hub, 'analyst', {
    onFrame: (m) => { if (m?.t === 'analyst:answer') { const a = m.answer; setAnswer(a?.markdown ? String(a.markdown) : a ? JSON.stringify(a).slice(0, 500) : '') } },
  })
  return (
    <AgentPage top={t.status} below={<>
      {answer && <Notice state="ok"><strong>Answer.</strong> {answer}</Notice>}
      <AskLine disabled={!t.live} busy={t.busy} placeholder="Ask the analyst a question…" verb="Ask"
        onAsk={(question) => { setAnswer(''); t.start(question, { t: 'analyse', question, sessionId: sid.current, questionId: crypto.randomUUID() }) }} />
    </>}>
      {t.view}
    </AgentPage>
  )
}
