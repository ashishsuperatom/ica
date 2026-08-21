// Render the sample in every theme, so the two looks can be compared side by side.
import { readFileSync, writeFileSync } from 'node:fs'
import { Renderer } from '@takumi-rs/wasm/node'
import { renderImage } from '../src/render/image.ts'
import { sampleAnswer } from '../src/sample.ts'
import { THEMES } from '../src/render/theme.ts'

const r = new Renderer()
// Register the one font file under every family name a theme asks for — locally we
// only have Inter, and an unregistered family renders as tofu.
for (const family of ['Inter', 'Helvetica Neue', 'Helvetica', 'Arial']) {
  for (const w of [400, 600, 700]) {
    await r.registerFont({ name: family, data: readFileSync(`assets/fonts/Inter-${w}.ttf`), weight: w, style: 'normal' })
  }
}

for (const name of Object.keys(THEMES)) {
  const out = await renderImage(sampleAnswer, r, {
    theme: name, scale: 2,
    title: 'Which branches make money, and which are dragging the network down?',
    footerLeft: 'Sample report · Superatom', footerRight: 'View the full report',
  })
  writeFileSync(`test/out/${name}.png`, out.bytes)
  console.log(`${name.padEnd(10)} ${out.bytes.length.toLocaleString().padStart(9)} bytes`)
}
