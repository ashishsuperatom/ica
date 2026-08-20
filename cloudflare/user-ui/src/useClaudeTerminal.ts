import { useEffect, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { ANSI, COLS, ROWS } from './termColors'

// The ONE terminal setup shared by every claude-code agent (analyst, modeler, …). The running MODEL is
// irrelevant to the UI — only the HARNESS is, so this is claude-code-specific; codex/opencode get their own
// views. Behavior is identical across agents; the only things that vary are passed as parameters:
//   which       — which agent's PTY to bind (routes term:input / term:attach / ui:resize)
//   interactive — true: keystrokes/paste go to the PTY (arrows, menu answers, /login); false: read-only view
//
// FIXED geometry (COLS×ROWS), never fit-to-container. The PTY is ONE stream shared by many viewers and its TUI
// is cursor-addressed for a single width — so every viewer renders at the SAME fixed size and we pin the shared
// PTY to it (the ui:resize below). If viewers fitted to their own container width instead, each would resize the
// shared PTY and garble the others. (Scrolling UP can still show jumbled history: a live TUI's scrollback is a
// stack of partial redraw frames; the live bottom frame is always clean.)
export function useClaudeTerminal(
  hostRef: RefObject<HTMLDivElement | null>,
  xtermRef: RefObject<Terminal | null>,
  opts: { which: string; interactive: boolean; send: (payload: any) => void },
) {
  const { which, interactive, send } = opts
  useEffect(() => {
    const term = new Terminal({
      // convertEol OFF — the PTY sends its own \r\n + control; converting them garbles the full-screen TUI.
      cols: COLS, rows: ROWS, cursorBlink: false, fontSize: 11, convertEol: false,
      scrollback: 8000, theme: { background: '#161a17', foreground: '#e6e2da', ...ANSI },
    })
    if (hostRef.current) term.open(hostRef.current)
    if (interactive) term.onData((d) => send({ t: 'term:input', which, data: d }))
    xtermRef.current = term
    send({ t: 'ui:resize', which, cols: COLS, rows: ROWS })   // pin the shared PTY to the fixed geometry BEFORE attach…
    send({ t: 'term:attach', which })                          // …so the replayed screen comes back at the right width
    return () => { term.dispose(); xtermRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which, interactive])
}
