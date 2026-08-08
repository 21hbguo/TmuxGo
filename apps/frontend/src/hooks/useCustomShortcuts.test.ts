import { describe, expect, it } from 'vitest'
import { keysToEscape, shortcutToInput, shortcutToSteps, stepToInput } from './useCustomShortcuts'

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
  it('falls back to legacy fields when steps are missing', () => {
    expect(shortcutToSteps({ id: 'a', label: 'A', mode: 'text', text: 'hi', appendEnter: true })).toEqual([{ type: 'text', text: 'hi', appendEnter: true }])
    expect(shortcutToSteps({ id: 'b', label: 'B', keys: 'Ctrl+C' })).toEqual([{ type: 'keys', keys: 'Ctrl+C' }])
    expect(shortcutToSteps({ id: 'c', label: 'C' })).toEqual([])
  })
  it('expands macro steps in order and renders wait steps empty', () => {
    const macro = {
      id: 'm',
      label: 'M',
      steps: [
        { type: 'text' as const, text: 'cd /app', appendEnter: true },
        { type: 'wait' as const, ms: 800 },
        { type: 'keys' as const, keys: 'Ctrl+L' },
      ],
    }
    expect(shortcutToSteps(macro)).toEqual(macro.steps)
    expect(stepToInput(macro.steps[0])).toBe('cd /app\r')
    expect(stepToInput(macro.steps[1])).toBe('')
    expect(stepToInput(macro.steps[2])).toBe('\x0c')
    expect(shortcutToInput(macro)).toBe('cd /app\r\x0c')
  })
})
