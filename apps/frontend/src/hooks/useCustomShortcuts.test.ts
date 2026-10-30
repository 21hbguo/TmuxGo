import { describe, expect, it } from 'vitest'
import { keysToEscape, shortcutToInput, shortcutToSteps, stepToInput } from './useCustomShortcuts'

describe('custom shortcut input', () => {
  it('keeps legacy key shortcuts working', () => {
    expect(shortcutToInput({ id: 'ctrl-c', label: 'Cancel', keys: 'Ctrl+C' })).toBe('\x03')
  })
  it('preserves text and adds enter only when requested', () => {
    expect(
      shortcutToInput({ id: 'status', label: 'Status', mode: 'text', text: 'printf "ok"\nnext', appendEnter: false }),
    ).toBe('printf "ok"\nnext')
    expect(shortcutToInput({ id: 'run', label: 'Run', mode: 'text', text: 'echo ok', appendEnter: true })).toBe(
      'echo ok\r',
    )
  })
  it('converts key sequences without changing their existing behavior', () => {
    expect(keysToEscape('Shift+Tab')).toBe('\x1b[Z')
    expect(keysToEscape('F5')).toBe('\x1b[15~')
  })
  it('encodes Alt/Meta as the ESC prefix so tmux M- bindings fire', () => {
    // 均匀布局宏 = prefix(C-b) → M-5(select-layout tiled)。Alt 被吞掉就退化成裸 "5"，
    // tmux 会当成选窗口，布局指令静默失效
    expect(keysToEscape('Alt+5')).toBe('\x1b5')
    expect(keysToEscape('Alt+k')).toBe('\x1bk')
    expect(keysToEscape('Meta+k')).toBe('\x1bk')
    expect(
      shortcutToInput({
        id: 'even',
        label: '均匀布局',
        steps: [
          { type: 'keys', keys: 'Ctrl+B' },
          { type: 'wait', ms: 50 },
          { type: 'keys', keys: 'Alt+5' },
        ],
      }),
    ).toBe('\x02\x1b5')
  })
  it('sends single keys with the recorded case and known names', () => {
    expect(keysToEscape('a')).toBe('a')
    expect(keysToEscape('A')).toBe('a')
    expect(keysToEscape('Shift+a')).toBe('A')
    expect(keysToEscape('5')).toBe('5')
    expect(keysToEscape('Space')).toBe(' ')
    expect(keysToEscape('Ctrl+Space')).toBe('\x00')
  })
  it('keeps shift variants for arrows and rejects unencodable keys', () => {
    expect(keysToEscape('Shift+Left')).toBe('\x1b[1;2D')
    expect(keysToEscape('Ctrl+1')).toBe('')
  })
  it('falls back to legacy fields when steps are missing', () => {
    expect(shortcutToSteps({ id: 'a', label: 'A', mode: 'text', text: 'hi', appendEnter: true })).toEqual([
      { type: 'text', text: 'hi', appendEnter: true },
    ])
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
