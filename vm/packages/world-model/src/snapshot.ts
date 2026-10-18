import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'

export interface SnapshotData {
  tree: unknown
  processedLines: number
}

// The snapshot is a disposable cache of the attractor tree, always
// rebuildable from the log alone. Written via temp-file + atomic rename so a
// crash mid-write never leaves a corrupted snapshot behind.
export function saveSnapshot(path: string, data: SnapshotData): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, path)
}

export function loadSnapshot(path: string): SnapshotData | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as SnapshotData
}
