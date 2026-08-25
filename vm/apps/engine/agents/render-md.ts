// ── render-md — the ONE way every agent-read markdown file is produced ──────────────────────────────────
// Agents read several .md files (SYSTEM.md, CONTEXT.md, the copied CONNECTOR.md/GROUNDING.md/…, the analyst's
// category files). Each is generated from a `generate-*.ts` sibling that defines its content as commented
// sections and calls writeMd() at module load; the owning index.ts imports that generator FIRST, so the .md is
// (re)written before it's read for promptVersion / baking. Both files live in git: the .ts is the SOURCE (with
// the why-lineage in comments), the .md is the rendered, human-readable artifact. Never hand-edit a generated
// .md — edit its generator .ts.
import { writeFileSync } from 'node:fs'

// Join the chosen sections into the .md. NO generated-banner: the agent READS these files, and a "generated —
// edit the source" note invites it to go edit the generator (not its job) or treat the prompt as machinery.
// Sections are right-trimmed and blank ones dropped; one blank line separates them — so the .ts controls exactly
// what ships (a section can exist but be left out of the array).
export function writeMd(outPath: string, sections: string[]): void {
  const body = sections.map((s) => s.replace(/\s+$/, '')).filter(Boolean).join('\n\n')
  writeFileSync(outPath, `${body}\n`)
}
