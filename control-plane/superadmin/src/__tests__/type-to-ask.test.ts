// The user app: what typed or pasted on the page goes to the ask bar.
import { describe, expect, it } from 'vitest'
import { textForAsk, type Moment } from '../../../user-ui/src/typeToAsk'

const free: Omit<Moment, 'key' | 'pasted'> = { fieldFocused: false, dialogOpen: false, askReady: true }
describe('type anywhere to ask', () => {
  it('a letter, capital or small, goes to the ask bar; a digit, a space, a shortcut or a key mid-composition does not', () => {
    expect(['a', 'Z'].map((key) => textForAsk({ ...free, key }))).toEqual(['a', 'Z'])
    expect(['1', ' ', 'Enter', 'ArrowDown', 'é'].map((key) => textForAsk({ ...free, key }))).toEqual([null, null, null, null, null])
    expect(textForAsk({ ...free, key: 'c', mods: true })).toBeNull()
    expect(textForAsk({ ...free, key: 'a', composing: true })).toBeNull()
  })
  it('pasted text goes to the ask bar whole', () => {
    expect(textForAsk({ ...free, pasted: 'revenue by month\nfor 2025' })).toBe('revenue by month\nfor 2025')
    expect(textForAsk({ ...free, pasted: '' })).toBeNull()
  })
  it('never while a field has the focus, a dialog is open, or the ask bar is busy or absent', () => {
    for (const m of [{ fieldFocused: true }, { dialogOpen: true }, { askReady: false }]) {
      expect(textForAsk({ ...free, ...m, key: 'a' })).toBeNull()
      expect(textForAsk({ ...free, ...m, pasted: 'x' })).toBeNull()
    }
  })
})
