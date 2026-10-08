import { describe, expect, it } from 'vitest'
import { explore, querySource, tableSource, ExploreRefusal } from '../../../../clients/explore'
import { checkQuery } from '../warehouse/access'
import type { TableInfo } from '../warehouse/bridge'

const ships: TableInfo = { name: 'ships', columns: [{ name: 'id', type: 'long' }, { name: 'lane', type: 'string' }, { name: 'at', type: 'date' }, { name: 'late', type: 'boolean' }] }

/** Every SQL the explorer makes must pass the warehouse's own access check; the answers are canned. */
function runner(answer: (sql: string) => Record<string, unknown>[], grant: Record<string, string[] | null> | null = null) {
  const seen: string[] = []
  const run = async (sql: string) => { checkQuery(sql, [ships], grant, 'org_x'); seen.push(sql); const rows = answer(sql); return { columns: Object.keys(rows[0] ?? {}), rows, truncated: false } }
  return { run, seen }
}

describe('the explorer\'s reads', () => {
  it('pages rows by their number in a stable order, searched and filtered, and counts them', async () => {
    const { run, seen } = runner((sql) => (sql.includes('sa_total') ? [{ sa_total: 3000 }] : [{ id: 101 }]))
    const r: any = await explore(run, tableSource(ships), { op: 'rows', table: 'ships', q: "o'k", where: [{ column: 'lane', value: 'coastal' }, { column: 'at', value: null }], sort: 'at', dir: 'desc', page: 3, size: 50 })
    expect(r).toMatchObject({ total: 3000, page: 3, size: 50, rows: [{ id: 101 }] })
    const page = seen.find((s) => s.includes('sa_rn'))!
    expect(page).toContain('ROW_NUMBER() OVER (ORDER BY "at" DESC NULLS LAST, "id", "lane", "late")')
    expect(page).toContain('sa_rn > 100 AND sa_rn <= 150')
    expect(page).toContain("CAST(\"lane\" AS VARCHAR) ILIKE '%o''k%'")
    expect(page).toContain("CAST(\"lane\" AS VARCHAR) = 'coastal' AND \"at\" IS NULL")
  })
  it('names only columns the reader may read — the check refuses anything else', async () => {
    const { run } = runner(() => [])
    await expect(explore(run, tableSource(ships), { op: 'values', table: 'ships', column: 'secret' })).rejects.toThrow(ExploreRefusal)
    await expect(explore(run, tableSource(ships), { op: 'rows', table: 'ships', where: [{ column: 'id"; DROP', value: 'x' }] })).rejects.toThrow(/not a column/)
    await expect(explore(run, tableSource(ships), { op: 'rows', table: 'ships', q: 'a\\b' })).rejects.toThrow(/backslash/)
    // A project granted two columns: the explorer is given only those, and asks for nothing more.
    const limited = { ...ships, columns: ships.columns.slice(0, 2) }
    const g = runner(() => [{ sa_total: 1 }], { ships: ['id', 'lane'] })
    await explore(g.run, tableSource(limited), { op: 'rows', table: 'ships', q: 'x' })
    expect(g.seen.join(' ')).not.toMatch(/"at"|"late"/)
  })
  it('takes an unnarrowed total from the snapshot, counting only when narrowed', async () => {
    const { run, seen } = runner(() => [{ id: 1 }])
    const r: any = await explore(run, tableSource({ ...ships, rows: 42 }), { op: 'rows', table: 'ships' })
    expect(r.total).toBe(42); expect(seen.some((q) => q.includes('sa_total'))).toBe(false)
  })
  it('explores a query\'s result like a table: its columns learnt once, its own order kept, the check still applied', async () => {
    const { run, seen } = runner((q) => (q.includes('sa_total') ? [{ sa_total: 2 }] : [{ lane: 'coastal', n: 3, 'count(*)': 1 }]))
    const src = await querySource(run, 'SELECT lane, COUNT(*) AS n, count(*) FROM ships GROUP BY lane ORDER BY 2 DESC;')
    expect(src.columns).toEqual([{ name: 'lane', type: 'string' }, { name: 'n', type: 'double' }])
    expect(src.skipped).toEqual(['count(*)'])
    expect(src.order).toEqual(['"n" DESC'])
    await explore(run, src, { op: 'rows', q: 'co', page: 1, size: 50 })
    const page = seen.find((q) => q.includes('sa_rn'))!
    expect(page).toContain('FROM (SELECT lane, COUNT(*) AS n, count(*) FROM ships GROUP BY lane ORDER BY 2 DESC) sa_q WHERE')
    expect(page).toContain('ORDER BY "n" DESC, "lane"')
    // A project that may not read the table cannot reach it through a query either.
    const p = runner(() => [{ lane: 'x' }], { other: null } as any)
    await expect(querySource(p.run, 'SELECT lane FROM ships')).rejects.toThrow(/may not read the table/)
  })
  it('counts every column\'s bins in one read', async () => {
    const { run, seen } = runner(() => [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`sa_b${i}`, i]))])
    const r: any = await explore(run, tableSource(ships), { op: 'bins', ranges: { id: [0, 100], at: [0, 86400 * 30], lane: [0, 1] } })
    expect(seen).toHaveLength(1)
    expect(Object.keys(r.bins)).toEqual(['id', 'at'])
    expect(r.bins.at[0]).toBe(20)
    expect(seen[0]).toContain("date_part('epoch', \"at\")")
  })
  it('profiles every column in one read, by kind', async () => {
    const { run, seen } = runner(() => [{ sa_rows: 10, sa_d0: 10, sa_c0: 10, sa_lo0: 1, sa_hi0: 10, sa_mean0: 5.5, sa_qa0: 3, sa_qb0: 5, sa_qc0: 8, sa_d1: 3, sa_c1: 8, sa_lo1: 'a', sa_hi1: 'z', sa_d2: 2, sa_c2: 10, sa_d3: 2, sa_c3: 9, sa_t3: 4 }])
    const p: any = await explore(run, tableSource(ships), { op: 'profile', table: 'ships' })
    expect(seen).toHaveLength(1)
    expect(p.rows).toBe(10)
    expect(p.columns[0]).toMatchObject({ kind: 'number', distinct: 10, nulls: 0, median: 5, mean: 5.5 })
    expect(p.columns[1]).toMatchObject({ kind: 'text', nulls: 2, min: 'a', max: 'z' })
    expect(p.columns[3]).toMatchObject({ kind: 'bool', nulls: 1, trues: 4 })
  })
  it('spreads numbers over twenty bins and dates by day or month', async () => {
    const n = runner((sql) => (sql.includes('sa_lo') ? [{ sa_lo: 0, sa_hi: 100 }] : [{ sa_b: 0, sa_n: 5 }, { sa_b: 20, sa_n: 1 }]))
    const s: any = await explore(n.run, tableSource(ships), { op: 'spread', table: 'ships', column: 'id' })
    expect(s.bins).toHaveLength(20); expect(s.bins[0]).toBe(5); expect(s.bins[19]).toBe(1)
    const d = runner((sql) => (sql.includes('sa_lo') ? [{ sa_lo: '2026-01-01', sa_hi: '2026-09-30' }] : [{ sa_at: '2026-01-01T00:00:00', sa_n: 7 }]))
    expect(await explore(d.run, tableSource(ships), { op: 'spread', table: 'ships', column: 'at' })).toEqual({ kind: 'time', unit: 'month', bins: [{ at: '2026-01', rows: 7 }] })
  })
})
