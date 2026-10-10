// The connector agent, live: connect a data source or run an infrastructure task. Its terminal is typeable, so an
// admin logs the agents in here (`/login`) — they share one $HOME, so a login here serves every claude agent.
import type { Hub } from './hub'
import { AgentPage, AskLine, useAgentTerminal } from './AgentTerminal'

export function ConnectorConsole({ hub }: { hub: Hub }) {
  const t = useAgentTerminal(hub, 'connector', { greeting: 'Connector agent — a live terminal. Type here to drive it (e.g. /login), or use the box below.' })
  return (
    <AgentPage top={t.status} below={<AskLine disabled={!t.live} busy={t.busy} placeholder="Ask the connector agent…" verb="Send"
      onAsk={(text) => t.start(text, { t: 'connector:ask', text, reqId: crypto.randomUUID() })} />}>
      {t.view}
    </AgentPage>
  )
}
