import { describe, expect, it } from 'vitest'
import { keysToEscape, shortcutToInput } from './useCustomShortcuts'

describe('custom shortcut input', () => {
  it('keeps legacy key shortcuts working', () => {
    expect(shortcutToInput({ id: 'ctrl-c', label: 'Cancel', keys: 'Ctrl+C' })).toBe('\x03')
  })
  it('preserves text and adds enter only when requested', () => {
    expect(shortcutToInput({ id: 'status', label: 'Status', mode: 'text', text: 'printf "ok"\nnext', appendEnter: false })).toBe('printf "ok"\nnext')
    expect(shortcutToInput({ id: 'run', label: 'Run', mode: 'text', text: 'echo ok', appendEnter: true })).toBe('echo ok\r')
  })
  it('converts key sequences without changing their existing behavior', () => {
    expect(keysToEscape('Shift+Tab')).toBe('\x1b[Z')
    expect(keysToEscape('F5')).toBe('\x1b[15~')
  })
})
