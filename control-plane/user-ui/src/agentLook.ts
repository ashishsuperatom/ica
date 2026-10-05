// How an agent is shown: its accent by token name (series-1, warn, primary, …), else a colour as given, else the first series.
import { ACCENT } from '@superatom/ui'

export const accentOf = (a?: string) => !a ? 'var(--series-1)' : (ACCENT as Record<string, string>)[a] ?? (/^(#|var\(|rgb|hsl|oklch)/.test(a) ? a : `var(--${a})`)
