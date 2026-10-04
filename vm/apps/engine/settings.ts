// The organisation's settings for this project home (settings.json: its time zone, currency), or none.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function projectSettings(projectDir: string): Record<string, unknown> {
  const file = join(projectDir, 'settings.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
}
