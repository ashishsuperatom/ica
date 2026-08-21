// Render the sample Answer to a real PNG + HTML on disk. This is the proof that the
// browser-free pipeline works end to end; open test/out/report.png to inspect it.
import { readFileSync, writeFileSync } from 'node:fs'
import { Renderer } from '@takumi-rs/wasm/node'
import { renderImage } from '../src/render/image.ts'
import { sampleAnswer } from '../src/sample.ts'

// The real product font. These same files ship to the Worker (see README: fonts are
// registered once per isolate, not per render).
const FONTS = [
  { path: 'assets/fonts/Inter-400.ttf', weight: 400 },
  { path: 'assets/fonts/Inter-600.ttf', weight: 600 },
  { path: 'assets/fonts/Inter-700.ttf', weight: 700 },
]

const renderer = new Renderer({})
for (const f of FONTS) {
  await renderer.registerFont({ name: 'Inter', data: readFileSync(f.path), weight: f.weight, style: 'normal' })
}

const t0 = Date.now()
const out = await renderImage(sampleAnswer, renderer, {
  title: 'Which branches make money, and which are dragging the network down?',
  footerLeft: 'Generated 21 Aug 2026 · Superatom',
  footerRight: 'View the full report',
  scale: 2,
})
const ms = Date.now() - t0

writeFileSync('test/out/report.png', out.bytes)
writeFileSync('test/out/report.html', out.html)
console.log(`rendered ${out.bytes.length.toLocaleString()} bytes in ${ms}ms, frame ${out.width}px`)
console.log('fit:', JSON.stringify(out.fit, null, 2))
