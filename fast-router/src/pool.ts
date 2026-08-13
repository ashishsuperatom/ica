// A pool of inference worker CHILD PROCESSES. The DO allows ONE 'fast-router' connection (singleton
// role), so we can't run N independent workers on the hub — instead the single main process holds the
// WS and hands each task to a free child, each of which owns its OWN warm model and runs on its own core.
// Child processes (not worker threads) because onnxruntime's native binding crashes in a worker thread.
// Size = FR_WORKERS. On a box with C cores, ~C workers is the sweet spot; more just contend.

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

interface Job { task: any; resolve: (r: any) => void; reject: (e: Error) => void; id: number }
interface Slot { cp: ChildProcess; job: Job | null; i: number }

export class Pool {
  private slots: Slot[] = []
  private queue: Job[] = []
  private nextId = 1
  private readyCount = 0
  private readyWaiters: (() => void)[] = []
  private respawns = 0
  private workerPath: string

  constructor(private size: number, workerUrl: URL) {
    this.workerPath = fileURLToPath(workerUrl)   // a .mjs bootstrap that registers tsx then imports the TS worker
    for (let i = 0; i < size; i++) this.spawn(i)
  }

  private spawn(i: number) {
    // fork sets up an IPC channel automatically; inherit stdout/stderr so child logs land in pm2.
    const cp = fork(this.workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const slot: Slot = { cp, job: null, i }
    cp.on('message', (m: any) => {
      if (m?.type === 'ready') { if (++this.readyCount >= this.size) this.readyWaiters.splice(0).forEach(r => r()); return }
      const job = slot.job; slot.job = null
      if (job) { m.ok ? job.resolve(m.payload) : job.reject(new Error(m.error || 'worker error')) }
      this.pump()
    })
    const onDead = (why: string) => {
      console.error(`[pool] worker #${i} ${why}`)
      if (slot.job) { slot.job.reject(new Error(`worker ${why}`)); slot.job = null }
      if (!this.slots.includes(slot)) return
      this.slots = this.slots.filter(s => s !== slot)
      if (++this.respawns > this.size * 5) { console.error('[pool] too many worker crashes — giving up'); process.exit(1) }
      this.spawn(i)   // keep the pool at size
    }
    cp.on('exit', (code) => { if (code !== 0) onDead(`exited (code ${code})`) })
    cp.on('error', (e) => onDead(`error: ${e.message}`))
    this.slots.push(slot)
  }

  // Resolves once every worker has loaded + warmed its model.
  ready(): Promise<void> {
    return new Promise(res => { this.readyCount >= this.size ? res() : this.readyWaiters.push(res) })
  }

  // Run a task on the next free worker (queues if all busy). Resolves with the worker's reply payload.
  run(task: any): Promise<any> {
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject, id: this.nextId++ }); this.pump() })
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue
      const job = this.queue.shift()!
      slot.job = job
      slot.cp.send({ id: job.id, task: job.task })
    }
  }
}
