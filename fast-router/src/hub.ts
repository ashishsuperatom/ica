// One resilient WS connection to this fast-router's own DO, registered as role 'fast-router'.
// Mirrors the code-engine client (vm/apps/code-engine/src/server.ts): hello → welcome → relay,
// auto-reconnect on close. It carries no intelligence — it just moves envelopes to/from the router.
// Code-engines dial the same DO as role 'runtime' (key-authed); the DO relays their `suggest` here.

import WebSocket from 'ws'
import { HUB_ROLE, type Envelope, type SuggestMsg, type IngestMsg, type ClassifyMsg, type NerMsg } from './protocol.js'
import { hubUrl, type Config } from './config.js'

const RECONNECT_MS = 5000

export interface HubHandlers {
  onSuggest: (msg: SuggestMsg, reply: (payload: any) => void) => void
  onIngest?: (msg: IngestMsg) => void
  onClassify?: (msg: ClassifyMsg, reply: (payload: any) => void) => void
  onNer?: (msg: NerMsg, reply: (payload: any) => void) => void
}

export class HubConnection {
  private ws: WebSocket | null = null
  private wsId: string | null = null
  private closed = false

  constructor(private cfg: Config, private handlers: HubHandlers) {}

  start() { this.connect() }
  stop() { this.closed = true; this.ws?.close() }

  private connect() {
    console.log(`[fast-router] connecting to hub id=${this.cfg.id}`)   // never log the key
    const ws = new WebSocket(hubUrl(this.cfg))
    this.ws = ws

    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: this.cfg.key, role: HUB_ROLE })))
    ws.on('message', (raw) => {
      let msg: Envelope
      try { msg = JSON.parse(raw.toString()) } catch { return }
      this.handle(msg)
    })
    ws.on('close', (code) => {
      this.ws = null; this.wsId = null
      if (this.closed) return
      console.log(`[fast-router] hub disconnected (${code}) — retrying in ${RECONNECT_MS / 1000}s`)
      setTimeout(() => this.connect(), RECONNECT_MS)
    })
    ws.on('error', (e) => console.error(`[fast-router] hub error: ${e.message}`))
  }

  private handle(msg: Envelope) {
    const payload = msg.payload
    if (payload?.t === 'welcome') { this.wsId = payload.wsId; console.log(`[fast-router] registered (${this.wsId})`); return }
    if (payload?.t === 'evicted') { console.warn(`[fast-router] evicted: ${payload.reason}`); return }
    if (payload?.t === 'error')   { console.warn(`[fast-router] hub error: ${payload.reason}`); return }
    if (!payload?.t) return

    // Reply goes back to the exact runtime that asked (the DO stamps `from` on the inbound message).
    const reply = (out: any) => this.send(msg.from ? { id: msg.from.id, type: msg.from.type } : undefined, out)

    if (payload.t === 'suggest')  { this.handlers.onSuggest(payload as SuggestMsg, reply); return }
    if (payload.t === 'ingest')   { this.handlers.onIngest?.(payload as IngestMsg); return }
    if (payload.t === 'classify') { this.handlers.onClassify?.(payload as ClassifyMsg, reply); return }
    if (payload.t === 'ner')      { this.handlers.onNer?.(payload as NerMsg, reply); return }
    // Unknown payloads are ignored — forward-compatible.
  }

  private send(to: { id?: string; type?: string } | undefined, payload: any) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ to, payload } as Envelope))
  }
}
