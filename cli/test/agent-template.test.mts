// The agent template as sacli carries it: the same as its folder, and a new agent made from it named for itself through
// and through — its program building as it stands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collect, render } from '../scripts/embed-agent-template.mjs'
import { initAgent } from '../src/agent-template.ts'
import { buildProgram, loadPackage, ProgramStore } from '../../vm/packages/programs/src/index.ts'
import { createStateEngine } from '../../vm/packages/state/src/index.ts'

test('the embedded template is the folder as it is now (pnpm build writes it)', () => {
  assert.equal(readFileSync(new URL('../src/agent-template.gen.ts', import.meta.url), 'utf8'), render(collect()), 'stale: run `pnpm -C cli build` (or node cli/scripts/embed-agent-template.mjs)')
})

test('a new agent is named for itself: agent, program, block and concepts by its name, its slice by the name as an identifier; its ICA\'s domain is the platform\'s', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'agent-')), 'spend-review')
  const made = initAgent(dir, 'spend-review')
  assert.ok(made.files.includes('programs/spend-review/manifest.json'))
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))
  assert.deepEqual([agent.name, agent.domain, agent.ica, agent.programs, Object.keys(agent.start)], ['spend-review', 'composer-domain', 'composer', ['spend-review'], ['spend_review']])
  const m = JSON.parse(readFileSync(join(dir, 'programs/spend-review/manifest.json'), 'utf8'))
  assert.deepEqual([m.id, m.name, m.ui.blocks, m.package.owns], ['prg_spend_review', 'spend-review', ['spend-review'], 'spend_review'])
  assert.match(readFileSync(join(dir, 'programs/spend-review/web/index.tsx'), 'utf8'), /export function SpendReview\(/)
  const knowledge = readFileSync(join(dir, 'knowledge/index.mts'), 'utf8')
  assert.match(knowledge, /name: 'spend-review\/entities-and-joins'/)
  assert.doesNotMatch(knowledge, /export const domains/, 'no domain of its own: its concepts are reached through intents')
  // the step standard: its filter is declared with the function that computes its choices, and the build takes it
  assert.deepEqual(m.package.filters.map((f: any) => [f.field, f.options]), [['group', 'groupOptions']])
  assert.match(readFileSync(join(dir, 'programs/spend-review/server/index.ts'), 'utf8'), /':::filters spend_review\.filters'/)
  assert.ok(!/\bexample\b/i.test(readFileSync(join(dir, 'programs/spend-review/server/index.ts'), 'utf8')))
  const built = buildProgram(join(dir, 'programs/spend-review'), new ProgramStore(mkdtempSync(join(tmpdir(), 'store-'))))
  assert.equal(built.manifest.name, 'spend-review')
  assert.throws(() => initAgent(dir, 'spend-review'), /there already/)
  assert.throws(() => initAgent(join(dir, '..', 'Bad Name'), 'Bad Name'), /not an agent name/)
  assert.ok(existsSync(join(dir, 'README.md')))
})

test('the template\'s program is a model of the step standard: its filter\'s choices computed from the data, then figures, words, a chart section and a table, in that order', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'agent-')), 'stock')
  initAgent(dir, 'stock')
  const store = new ProgramStore(mkdtempSync(join(tmpdir(), 'store-')))
  const pkg = await loadPackage(store, buildProgram(join(dir, 'programs/stock'), store).hash)
  // a source standing in: the groups in scope for the filter, the keys in scope for the view
  const asked: string[] = []
  const query = async (_src: string, sql: string, params: Record<string, unknown> = {}) => {
    asked.push(`${/grp AS value/.test(sql) ? 'choices' : 'keys'} ${JSON.stringify(params)}`)
    return /grp AS value/.test(sql) ? [{ value: 'North', count: 2, amount: 30 }, { value: 'South', count: 1, amount: 10 }]
      : [{ key: 'K1', value: 25, total: 30, keys: 2 }, { key: 'K2', value: 5, total: 30, keys: 2 }]
  }
  const engine = createStateEngine([pkg], { services: { query } })
  const out = await engine.dispatch(engine.start(), [{ op: 'set', path: 'stock.group', value: 'North' }])
  const a = out.ran[0].answer!
  assert.deepEqual(a.markdown.split('\n').filter((l) => /^(\*\*|:::|## )/.test(l)).map((l) => l.split(' ')[0]),
    ['**Stock**', ':::filters', ':::kpis', '##', ':::bars', ':::table'])
  const row = a.blocks!['stock.filters'] as any
  assert.deepEqual(row.filters[0].choices.map((c: any) => [c.value, c.count, c.amount]), [['North', 2, 30], ['South', 1, 10]])
  assert.deepEqual(row.filters[0].value, ['North'])
  assert.match(a.markdown, /K1 carries 83% of the total, the largest of 2 keys\./, 'words said from the data')
  assert.deepEqual(asked, ['keys {"group":"North"}', 'choices {}'], 'the choices in the scope the other narrowings leave')
})
