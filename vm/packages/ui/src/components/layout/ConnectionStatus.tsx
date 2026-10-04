// How the screen reaches the platform right now, in one small pill.

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'

export default function ConnectionStatus({ status, message }: { status: Connection; message?: string }) {
  const colour = status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  return (
    <span className="sa-status" title={message || word}>
      <span className="sa-dot" style={{ background: colour }} />
      {word}
      {message && status !== 'mock' && <span className="sa-status__detail">· {message}</span>}
    </span>
  )
}
