// WATCHING A PROGRAM RUN, from outside it.
//
// A program that takes three minutes and a program that has hung look identical from the UI. That is the whole
// problem this solves: a 186-second gap in the narration turned out to be a perfectly healthy query, but there
// was no way to know that without reading the engine's log.
//
// It is a FILE TAIL rather than a pipe, and that is the point. A program is run two ways — by the engine
// (execProgram, whose output we could have piped) and by the agent authoring it, from its own shell. The
// agent's runs are the long ones, and their output goes to the agent's session, not to us. `run.mjs` is the
// one wrapper both paths share, so it appends every event to the spool and this reads it. The same trace
// either way, and no branch anywhere that has to know which kind of run it was watching.
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Beside db/, NOT inside the workspace: the agent's cwd is workspace/, and a file it did not create sitting in
// the directory it writes its results to is something to be read or tidied away. `run.mjs` reaches it from the
// other side as ../run-events.jsonl — the same relative idiom the seams already use for the databases.
export const EVENTS_FILE = (workspace: string) => join(workspace, '..', 'run-events.jsonl')

export interface ProgramEventLine {
  t: string                 // program:start | program:end | program:failed | unit:start | unit:end | decide | log | query:start | query:end
  run: string               // which run produced it — several programs can be in flight in one workspace
  program: string
  at: number
  // WHOSE turn this run belongs to, when the starter knew. Present when the ENGINE started the program (it
  // stamps SA_QID/SA_SID); absent when the agent started one from its own shell, whose environment comes from
  // the agent's session rather than the turn. A reader must handle both — the spool is shared by every chat in
  // the project, and an unattributed line delivered to the wrong person shows them someone else's data.
  qid?: string
  sid?: string
  [k: string]: unknown
}

/** Follow the file from wherever it currently ends, calling back on each new line. Returns a stop function.
 *
 *  From the END, deliberately: a turn cares about what happens NEXT, and the spool may still hold the tail of
 *  an earlier run. Replaying that when a turn begins would show a user someone else's query as if it were their
 *  own. */
export function watchProgramEvents(workspace: string, onEvent: (ev: ProgramEventLine) => void, everyMs = 250) {
  const path = EVENTS_FILE(workspace)
  let offset = 0
  let positioned = false              // decided once, on the first poll — see below
  let startedEmpty = false            // there was no spool when the turn began, so anything that appears is ours
  let stopped = false
  let reading = false
  let partial = ''                    // a line split across two reads

  const poll = async () => {
    if (stopped || reading) return
    reading = true
    try {
      const size = (await stat(path).catch(() => null))?.size

      // WHERE TO START, decided once. If a spool already existed when this turn began, its contents are an
      // earlier run's and are skipped. If there was NO file, everything that appears in it is new and is read
      // from byte zero — which is the case that matters, because the spool is created by the first program run
      // and its opening events are the ones saying that a program has started at all.
      if (!positioned) {
        // No spool yet. Remember that, and keep looking: when one appears, every byte in it is new and ours.
        if (size == null) { startedEmpty = true; return }
        positioned = true
        // A spool that already existed when the turn began holds an earlier run — skip it. One that appeared
        // afterwards is this turn's, and is read from the first byte. Then fall THROUGH and read: the content
        // is already there, and waiting for the next poll would drop the opening events.
        offset = startedEmpty ? 0 : size
        if (!startedEmpty) return
      }
      if (size == null) { offset = 0; partial = ''; return }   // deleted under us — the next one starts fresh
      if (size < offset) { offset = 0; partial = '' }  // truncated (the spool rolled) — read it from the top
      if (size === offset) return

      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        await fh.read(buf, 0, buf.length, offset)
        offset = size
        const text = partial + buf.toString('utf8')
        const lines = text.split('\n')
        partial = lines.pop() ?? ''                     // the tail may be half a line; keep it for next time
        for (const line of lines) {
          const s = line.trim()
          if (!s) continue
          try { onEvent(JSON.parse(s) as ProgramEventLine) } catch { /* a torn line is not worth a crash */ }
        }
      } finally { await fh.close() }
    } catch { /* transient — the next poll retries */ }
    finally { reading = false }
  }

  // Position BEFORE returning, so a program that starts immediately cannot slip in between construction and
  // the first poll — its opening events are the ones worth having.
  const ready = poll()
  const timer = setInterval(poll, everyMs)
  // NEVER the reason a process stays alive. A watcher observes; it has no work of its own worth keeping the
  // event loop open for. Without unref, a turn whose cleanup was skipped would hold the engine up for ever —
  // and it hung a test run, which is the cheap way to have found out.
  timer.unref?.()
  void ready
  return () => { stopped = true; clearInterval(timer) }
}

/** One human line for an event, or '' for the ones with nothing to say. The UI renders the structure; this is
 *  what goes in a log, and what a client too old to know these events can still fall back to. */
export function describeProgramEvent(ev: ProgramEventLine): string {
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined)
  switch (ev.t) {
    case 'program:start':  return `running ${ev.program}`
    case 'program:end':    return `finished ${ev.program} (${n(ev.ms) ?? '?'}ms, ${n(ev.nodes) ?? '?'} steps)`
    case 'program:failed': return `FAILED ${ev.program} — ${String(ev.error ?? '').slice(0, 200)}`
    case 'unit:start':     return `${ev.unit}…`
    case 'unit:end':       return `${ev.unit} (${n(ev.ms) ?? '?'}ms${n(ev.rows) != null ? `, ${n(ev.rows)} rows` : ''})`
    case 'decide':         return `${ev.label} → ${ev.took ? 'yes' : 'no'} — ${ev.reason}`
    case 'log':            return String(ev.text ?? '')
    case 'query:start':    return `querying ${ev.source}…`
    case 'query:end':      return ev.error
      ? `query on ${ev.source} failed after ${n(ev.ms) ?? '?'}ms — ${String(ev.error).slice(0, 200)}`
      : `${ev.source} returned ${n(ev.rows) ?? '?'} rows in ${n(ev.ms) ?? '?'}ms`
    default:               return ''
  }
}
