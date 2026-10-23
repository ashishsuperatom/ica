// The mail relay must stay a mail relay. This is a static check, not a proof:
// it catches the imports and side effects that would make the module reach into
// the render/storage path or write content somewhere.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mailDir = fileURLToPath(new URL('../src/mail/', import.meta.url))
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
}
walk(mailDir)

const failures = []
const importPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const relative = file.slice(mailDir.length)

  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1]
    if (!specifier.startsWith('./') && specifier !== 'cloudflare:workers') {
      failures.push(`${relative}: imports outside the mail module: ${specifier}`)
    }
  }
  if (/\bconsole\s*\./.test(text)) failures.push(`${relative}: uses console`)
  if (/\bfetch\s*\(/.test(text)) failures.push(`${relative}: calls fetch (the VM has no internet; the relay has no other transport)`)
  if (/\bR2Bucket\b|\bREPORTS\b|\bstore\.js\b/.test(text)) failures.push(`${relative}: references the render/storage path`)
}

if (failures.length) {
  console.error('✗ mail module is not isolated:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`✓ mail module isolated (${files.length} files; no logging, fetch, R2 or render imports)`)
