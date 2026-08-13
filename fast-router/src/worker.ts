// One pool worker — a CHILD PROCESS (not a worker thread: onnxruntime's native binding crashes in a
// worker thread's V8 isolate). As a normal process it owns its own warm models (GLiNER + MiniLM) and
// Qdrant client via the imported modules, exactly like the single-worker setup that already works.
// Talks to the parent over fork's IPC channel. Handles one task at a time (the pool never double-sends).

import { suggest, ingest } from './router.js'
import { classify, extractEntities, warmGliner } from './gliner.js'
import { warmEmbed } from './embed.js'

if (!process.send) throw new Error('worker must be spawned with an IPC channel (child_process.fork)')
const send = process.send.bind(process)

// Load + warm both models before announcing readiness.
await Promise.all([warmEmbed(), warmGliner()])
send({ type: 'ready' })

process.on('message', async ({ id, task }: { id: number; task: any }) => {
  const t = Date.now()
  try {
    let payload: any = null
    switch (task.t) {
      case 'suggest':  payload = await suggest(task); break                    // SuggestionsMsg | null
      case 'classify': { const r = await classify(task.text, task.labels, { multiLabel: task.multiLabel, threshold: task.threshold }); payload = { t: 'classify:result', reqId: task.reqId, top: r.top, scores: r.scores, ms: Date.now() - t }; break }
      case 'ner':      { const entities = await extractEntities(task.text, task.labels); payload = { t: 'ner:result', reqId: task.reqId, entities, ms: Date.now() - t }; break }
      case 'ingest':   await ingest(task.projectId, task.question, { params: task.params }); break   // fire-and-forget
    }
    send({ id, ok: true, payload })
  } catch (e) {
    send({ id, ok: false, error: (e as Error).message })
  }
})
