// The project's programs in the tool tree (program-tree.ts): read with ./inspect like the platform's tools, made for the
// person asking — the newest published build of each, or their own newer draft.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore } from '@superatom/programs'
import { inspectTools, TOOL_CARDS } from '@superatom/platform-types'
import { buildsFor, programCards } from '../program-tree.ts'

test('which build each person reads: the newest published, or their own newer draft — never someone else\'s draft', () => {
  const rows = [
    { name: 'explore', hash: 'h-pub1', uploaded_at: '2026-11-01', published_at: '2026-11-01', built_by: 'u1' },
    { name: 'explore', hash: 'h-pub2', uploaded_at: '2026-11-05', published_at: '2026-11-05', built_by: 'u1' },
    { name: 'explore', hash: 'h-mine', uploaded_at: '2026-11-09', published_at: null, built_by: 'u2' },
    { name: 'award', hash: 'h-theirs', uploaded_at: '2026-11-09', published_at: null, built_by: 'u3' },
  ]
  assert.deepEqual(buildsFor(rows, 'u1'), [{ name: 'explore', hash: 'h-pub2', draft: false }])
  assert.deepEqual(buildsFor(rows, 'u2'), [{ name: 'explore', hash: 'h-mine', draft: true }])
  assert.deepEqual(buildsFor(rows, 'u3').map((b) => b.name).sort(), ['award', 'explore'])
  assert.deepEqual(buildsFor(rows, null), [{ name: 'explore', hash: 'h-pub2', draft: false }])
})

test('./inspect programs: the list, a program with its STATE and functions, a function with its params and how to run it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ptree-'))
  try {
    const store = new ProgramStore(join(root, 'store'))
    const built = buildProgram(fileURLToPath(new URL('../../../packages/programs/test/fixtures/unsettled-trips', import.meta.url)), store)
    const cards = [...TOOL_CARDS, ...programCards([{ name: 'trips', hash: built.hash, draft: true }], store)]
    assert.match(inspectTools('', cards)!, /- programs — The project's programs/)
    const list = inspectTools('programs', cards)!
    assert.match(list, /- programs\.trips — .*your draft, not published \(\.\/inspect programs\.trips\)/)
    const one = inspectTools('programs.trips', cards)!
    assert.match(one, /^### trips — /); assert.match(one, /Its STATE \(trips\): branch \(string, may be left out\)/)
    assert.match(one, /- \.\/run-program trips\.nextPage '\{\}' — /)
    const fn = inspectTools('programs.trips.run', cards)!
    assert.match(fn, /^### trips\.run — /); assert.match(fn, /Run: \.\/run-program trips\.run '\{\}'/); assert.match(fn, /Gives: a step/)
    const views = inspectTools('programs.trips.views', cards)!
    assert.match(views, /what trips draws: UnsettledTrips/); assert.match(views, /- with the step's answer — How many trips are left to settle/)
    assert.match(inspectTools('programs.trips.views.UnsettledTrips', cards)!, /It shows: count\.[\s\S]*Its moves: none\./)
    assert.equal(inspectTools('programs.nothing', cards), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
