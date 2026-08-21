// ── The Takumi renderer, one per isolate ─────────────────────────────────────
// Instantiating the wasm module and parsing ~1MB of font is expensive and happens
// ONCE per isolate, not once per request. The first request into a cold isolate
// pays for it; every later request on that isolate reuses the renderer.
//
// `@takumi-rs/wasm/auto` resolves to the workerd build under Wrangler, which
// imports the .wasm as a real WebAssembly.Module — the Workers-native way, with no
// fetch and no base64.

import { initSync, Renderer } from '@takumi-rs/wasm'
import wasmModule from '@takumi-rs/wasm/auto'
import { INTER } from './fonts.js'
import type { Rasteriser } from './render/image.js'

let ready: Promise<Rasteriser> | null = null

export function renderer(): Promise<Rasteriser> {
  // Cached as the PROMISE, not the result: two concurrent requests into a cold
  // isolate must share one initialisation rather than race to build two renderers.
  if (!ready) {
    ready = (async () => {
      initSync({ module: wasmModule as WebAssembly.Module })
      const r = new Renderer()
      for (const f of INTER) await r.registerFont(f as never)
      return r as unknown as Rasteriser
    })().catch((e) => { ready = null; throw e })   // a failed init must not be cached
  }
  return ready
}
