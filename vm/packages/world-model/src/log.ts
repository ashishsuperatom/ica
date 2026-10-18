import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import type { Who } from './attractor.js'

export interface DecisionLine {
  type: 'decision'
  decisionId: string
  fingerprint: string
  action: string
  who: Who
  ts: number
  activeSignalIds?: string[]
}

export interface OutcomeLine {
  type: 'outcome'
  decisionId: string
  outcome: boolean | 0 | 1
  ts: number
}

export type LogLine = DecisionLine | OutcomeLine

// Append-only, durable per write. This is the audit trail: a decision record
// is written the moment it's made (even if no outcome ever arrives), and an
// outcome record is written separately when it's known. Never edited.
export class DecisionLog {
  constructor(private filePath: string) {
    if (!existsSync(filePath)) writeFileSync(filePath, '')
  }

  appendDecision(rec: Omit<DecisionLine, 'type'>): void {
    appendFileSync(this.filePath, JSON.stringify({ type: 'decision', ...rec }) + '\n')
  }

  appendOutcome(rec: Omit<OutcomeLine, 'type'>): void {
    appendFileSync(this.filePath, JSON.stringify({ type: 'outcome', ...rec }) + '\n')
  }

  readAllLines(): LogLine[] {
    const text = readFileSync(this.filePath, 'utf8')
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as LogLine)
  }
}
