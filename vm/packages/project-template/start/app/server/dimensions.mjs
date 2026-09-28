// What this application knows about, as data: every dimension a question may be narrowed or broken down by, and the
// column that carries it on each fact (each domain program). A fact without that column cannot be narrowed by it —
// that is the grain check: a view asking a fact for a filter the fact does not carry is refused with the sentence.
//
//   key, label, plural, means   how the dimension is named and said
//   grain     what the filter is a property of (the row it belongs to)
//   kind      entity (members with ids) · attribute (a value recorded on a row) · flag (yes or no)
//   members   where a person chooses from: searched in the source and capped (search: a find.mjs list), the values
//             a fact holds, counted there (fact + value), or the values a program's rule states (values)
//   fields    fact → the program's column holding the member's id or value

export const DIMENSIONS = [
]

export const DIMENSION = new Map(DIMENSIONS.map((d) => [d.key, d]))

/** The chain of containment from the outermost down to `key` (no dimension here contains another). */
export const lineage = (key) => [key]
/** Every dimension inside `key`: none. */
export const beneath = () => []

/** What a condition needs to know beyond the question: nothing here (no dimension is a tree). */
export const lookups = async () => undefined

/** Whether a fact's rows carry a dimension. */
export const carries = (key, fact) => !!DIMENSION.get(key)?.fields?.[fact]

const YES = /^(yes|y|true|t|1)$/i
const truthy = (v) => v === true || YES.test(String(v ?? ''))

/** The keys a filter stands for: one value, or several (one name recorded more than once, a place booked two ways). */
export const keysOf = (f) => [...new Set((Array.isArray(f.value) ? f.value : [f.value]).map(String))]

/** One filter as the program's own condition (`--where`). */
export function programWhere(f, fact) {
  const d = DIMENSION.get(f.dim)
  if (!d) throw new Error(`there is no dimension "${f.dim}"`)
  const field = d.fields?.[fact]
  if (!field) throw new Error(`${fact} is not recorded by ${d.label.toLowerCase()}`)
  const not = f.op === 'is not'
  if (d.kind === 'flag') return `${field}=${truthy(f.value) !== not}`
  const keys = keysOf(f)
  if (keys.some((k) => k.includes(','))) throw new Error(`a ${d.label.toLowerCase()} value holds a comma`)
  return `${field}${not ? '!=' : '='}${keys.join(',')}`
}
