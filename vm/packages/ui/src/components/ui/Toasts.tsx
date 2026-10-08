import { Icon } from './Icon'
import { dismiss, useToasts } from '../../lib/toast'

const LOOK = { refused: { icon: 'lucide:ban', word: 'Refused' }, error: { icon: 'lucide:alert-triangle', word: 'Error' }, note: { icon: 'lucide:info', word: 'Note' } } as const

export default function Toasts() {
  const list = useToasts()
  if (!list.length) return null
  return (
    <div className="sa-toast-stack" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="sa-toast" data-kind={t.kind}>
          <Icon icon={LOOK[t.kind].icon} className="sa-toast__icon" />
          <span className="sa-label sa-toast__kind">{LOOK[t.kind].word}</span>
          <span className="sa-toast__text">{t.text}</span>
          <button className="sa-icon-btn sa-icon-btn--sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon icon="lucide:x" /></button>
        </div>
      ))}
    </div>
  )
}
