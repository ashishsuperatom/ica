// The grounding agent, live: a cold, one-shot builder of this project's value→id indexes, not a chat. Build adds on
// top of what is there (safe to run again); Rebuild is the one destructive path — it empties the index first.
import { useConfirm } from '@superatom/ui'
import type { Hub } from './hub'
import { AgentPage, useAgentTerminal } from './AgentTerminal'

export function GroundingConsole({ hub }: { hub: Hub }) {
  const t = useAgentTerminal(hub, 'grounding', {
    greeting: 'Grounding agent — press Build to construct this project’s value→id indexes, and watch it work.',
    onFrame: (m, say) => { if (m?.t === 'grounding:done' && m.summary) say(`\r\n\x1b[32m✓ ${m.summary}\x1b[0m`) },
  })
  const [confirm, confirmDialog] = useConfirm()
  const build = async (rebuild: boolean) => {
    if (rebuild && !await confirm({ title: 'Rebuild the grounding index from empty?', body: 'This deletes every value→id entry it holds now, then builds again from the data.', confirm: 'Wipe and rebuild', danger: true })) return
    t.start(rebuild ? 'Rebuild grounding (clear first)' : 'Build / improve grounding', { t: 'grounding:build', rebuild })
  }
  return (
    <AgentPage top={<>
      {t.status}<span className="sa-grow" />
      <button className="sa-btn" onClick={() => build(true)} disabled={t.busy || !t.live} title="Empty the index and build it again">Rebuild from empty</button>
      <button className="sa-btn sa-btn--primary" onClick={() => build(false)} disabled={t.busy || !t.live}>{t.busy ? 'Building…' : 'Build / improve'}</button>
    </>}>
      {confirmDialog}
      {t.view}
    </AgentPage>
  )
}
