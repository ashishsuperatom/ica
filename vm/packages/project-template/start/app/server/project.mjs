// What this dashboard is called and its starting points, as the client draws them: one scenario per domain, each with
// its colour, icon and one line. The client holds no project's words; they are here — and how a person finds the
// members of a dimension to choose from.

export const PROJECT = { name: '{{NAME}}', locale: '{{LOCALE}}', currency: '{{CURRENCY}}' }

/** { key, label, accent: 'series-1'…'series-4' | 'warn', icon: 'lucide:<name>', says } — a view names its scenario by key. */
export const SCENARIOS = [
]

/** Members of a dimension a person chooses from, searched in the source by the find fact (at most 20). `read` reads a
 *  fact. */
export async function members(d, typed, read) {
  return ((await read('find', { search: { list: d.members.search, words: typed } })).data ?? []).map((x) => ({ key: String(d.members.value ? x[d.members.value] : x.id), label: x.name }))
}
