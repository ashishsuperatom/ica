import { useEffect, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'

// The ONE terminal setup shared by every claude-code agent (analyst, modeler, …). The running MODEL is
// irrelevant to the UI — only the HARNESS is, so this is claude-code-specific; codex/opencode get their own
// views. Behavior is identical across agents; the only things that vary are passed as parameters:
//   which       — which agent's PTY to bind (routes term:input / term:attach)
//   interactive — true: keystrokes/paste go to the PTY (arrows, menu answers, /login); false: read-only view
// claude-code renders a full-screen TUI at a FIXED 120×34 width (ica/claude.ts); a dynamic width garbles the
// live status line, so we pin 120 cols. Attach on mount so the live PTY stream + screen replay are wired
// whenever the terminal exists (more reliable than attaching only on connect).
export function useClaudeTerminal(
  hostRef: RefObject<HTMLDivElement | null>,
  xtermRef: RefObject<Terminal | null>,
  opts: { which: string; interactive: boolean; send: (payload: any) => void },
) {
  const { which, interactive, send } = opts
  useEffect(() => {
    const term = new Terminal({
      cols: 120, rows: 40, cursorBlink: false, fontSize: 11, convertEol: true,
      scrollback: 8000, theme: { background: '#161a17', foreground: '#bcd0be' },
    })
    if (hostRef.current) term.open(hostRef.current)
    if (interactive) term.onData((d) => send({ t: 'term:input', which, data: d }))
    send({ t: 'term:attach', which })
    xtermRef.current = term
    return () => { term.dispose(); xtermRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which, interactive])
}
