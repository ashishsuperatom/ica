import { describe, it, expect, vi, afterEach } from 'vitest'
import { keepAlive } from '../../../shared/heartbeat'

afterEach(() => { vi.useRealTimers() })

describe('a tab keeping its connection alive', () => {
  it('beats while answered, and never calls the connection dead', () => {
    vi.useFakeTimers()
    let beats = 0, dead = 0
    const a = keepAlive({ beat: () => { beats++; setTimeout(() => a.heard(), 50) }, dead: () => dead++, every: 1000, grace: 300 })
    vi.advanceTimersByTime(5_100)
    expect(beats).toBe(5); expect(dead).toBe(0)
    a.stop()
  })
  it('calls a silent connection dead once, after the grace — and beats no more', () => {
    vi.useFakeTimers()
    let beats = 0, dead = 0
    keepAlive({ beat: () => beats++, dead: () => dead++, every: 1000, grace: 300 })
    vi.advanceTimersByTime(1_299); expect(dead).toBe(0)
    vi.advanceTimersByTime(1); expect(dead).toBe(1)
    vi.advanceTimersByTime(10_000); expect(dead).toBe(1); expect(beats).toBe(1)
  })
  it('anything heard counts as an answer', () => {
    vi.useFakeTimers()
    let dead = 0
    const a = keepAlive({ beat: () => {}, dead: () => dead++, every: 1000, grace: 300 })
    vi.advanceTimersByTime(1_100); a.heard()   // something else arrived while the heartbeat was out
    vi.advanceTimersByTime(800)                 // past that heartbeat's grace, before the next beat
    expect(dead).toBe(0)
    a.stop()
  })
})
