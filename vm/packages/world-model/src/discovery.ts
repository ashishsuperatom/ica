// Schema-agnostic field discovery: walk arbitrary JSON and classify leaves by
// TYPE and SHAPE, never by name. This is what lets a concept be defined
// without knowing a key exists in advance.

export interface NumericField {
  path: string[]
  value: number
}

export interface TimeSeriesField {
  path: string[]
  values: number[]
}

export function findNumericFields(obj: unknown, path: string[] = []): NumericField[] {
  const out: NumericField[] = []
  walk(obj, path, (p, v) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ path: p, value: v })
  })
  return out.sort((a, b) => a.path.join('.').localeCompare(b.path.join('.')))
}

export function findTimeSeriesFields(obj: unknown, path: string[] = []): TimeSeriesField[] {
  const out: TimeSeriesField[] = []
  walk(obj, path, (p, v) => {
    if (Array.isArray(v) && v.length >= 2 && v.every(x => typeof x === 'number' && Number.isFinite(x))) {
      out.push({ path: p, values: v as number[] })
    }
  })
  return out.sort((a, b) => a.path.join('.').localeCompare(b.path.join('.')))
}

function walk(obj: unknown, path: string[], visit: (path: string[], value: unknown) => void): void {
  if (obj === null || obj === undefined) return
  if (Array.isArray(obj)) {
    visit(path, obj) // let the caller test "is this a timeseries" on the array itself
    if (!obj.every(x => typeof x === 'number')) {
      obj.forEach((v, i) => walk(v, [...path, String(i)], visit))
    }
    return
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) walk(v, [...path, k], visit)
    return
  }
  visit(path, obj)
}
