import { describe, expect, it } from 'vitest'
import {
  EDITOR_COMMANDS,
  EDITOR_COMMANDS_BY_ID,
  formatKeybinding,
  MONACO_ACTIONS,
  resolveEditorKey,
  type EditorKeyInput,
} from './editor-commands'

const key = (patch: Partial<EditorKeyInput> & { key: string }): EditorKeyInput => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
})

describe('editor command table', () => {
  it('has unique ids and non-empty titles/keywords', () => {
    const ids = EDITOR_COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const command of EDITOR_COMMANDS) {
      expect(command.titleKey, command.id).toMatch(/^editor\.cmd\./)
      expect(command.keywords.length, command.id).toBeGreaterThan(0)
    }
  })

  it('indexes every command by id', () => {
    expect(EDITOR_COMMANDS_BY_ID.size).toBe(EDITOR_COMMANDS.length)
    expect(EDITOR_COMMANDS_BY_ID.get('goto-line')?.keybinding).toBe('Mod+G')
  })

  it('formats keybindings per platform', () => {
    expect(formatKeybinding('Mod+K Mod+S', false)).toBe('Ctrl+K Ctrl+S')
    expect(formatKeybinding('Mod+Alt+Up', true)).toBe('Cmd+Option+Up')
    expect(formatKeybinding(undefined, false)).toBe('')
  })

  it('maps monaco-native commands to real action ids', () => {
    expect(MONACO_ACTIONS.replace).toBe('editor.action.startFindReplaceAction')
    expect(MONACO_ACTIONS['format-document']).toBe('editor.action.formatDocument')
  })
})

describe('resolveEditorKey', () => {
  it('resolves plain editor shortcuts', () => {
    const cases: [EditorKeyInput, string][] = [
      [key({ key: 'g', ctrlKey: true }), 'goto-line'],
      [key({ key: 'G', metaKey: true }), 'goto-line'],
      [key({ key: 'o', ctrlKey: true, shiftKey: true }), 'goto-symbol'],
      [key({ key: 't', ctrlKey: true, shiftKey: true }), 'reopen-closed'],
      [key({ key: 'z', altKey: true }), 'toggle-word-wrap'],
      [key({ key: 'f', altKey: true, shiftKey: true }), 'format-document'],
      [key({ key: 'h', ctrlKey: true }), 'replace'],
      [key({ key: 's', ctrlKey: true }), 'save'],
      [key({ key: 'w', ctrlKey: true }), 'close'],
      [key({ key: '=', ctrlKey: true }), 'zoom-in'],
      [key({ key: '+', ctrlKey: true }), 'zoom-in'],
      [key({ key: '+', ctrlKey: true, shiftKey: true }), 'zoom-in'],
      [key({ key: '_', ctrlKey: true, shiftKey: true }), 'zoom-out'],
      [key({ key: '-', ctrlKey: true }), 'zoom-out'],
      [key({ key: '0', ctrlKey: true }), 'zoom-reset'],
      [key({ key: '\\', ctrlKey: true }), 'split-right'],
      [key({ key: 'PageDown', ctrlKey: true }), 'next-editor'],
      [key({ key: 'PageUp', ctrlKey: true }), 'previous-editor'],
      [key({ key: 'F12' }), 'goto-definition'],
      [key({ key: 'ArrowLeft', altKey: true }), 'navigate-back'],
      [key({ key: 'ArrowRight', altKey: true }), 'navigate-forward'],
    ]
    for (const [input, expected] of cases)
      expect(resolveEditorKey(input, null), input.key).toEqual({ type: 'command', id: expected })
  })

  it('opens the shortcut sheet with Mod+Shift+/ in both key layouts', () => {
    expect(resolveEditorKey(key({ key: '/', ctrlKey: true, shiftKey: true }), null)).toEqual({
      type: 'command',
      id: 'show-shortcuts',
    })
    expect(resolveEditorKey(key({ key: '?', ctrlKey: true, shiftKey: true }), null)).toEqual({
      type: 'command',
      id: 'show-shortcuts',
    })
  })

  it('handles the Alt+K chord and drops unknown continuations', () => {
    expect(resolveEditorKey(key({ key: 'k', altKey: true }), null)).toEqual({ type: 'chord', chord: 'alt+k' })
    expect(resolveEditorKey(key({ key: 's', altKey: true }), 'alt+k')).toEqual({ type: 'command', id: 'save-all' })
    expect(resolveEditorKey(key({ key: 'w', altKey: true }), 'alt+k')).toEqual({ type: 'command', id: 'close-all' })
    expect(resolveEditorKey(key({ key: 'x', altKey: true }), 'alt+k')).toBeNull()
    // 和弦状态下再按 Alt+K 不应重新进和弦
    expect(resolveEditorKey(key({ key: 'k', altKey: true }), 'alt+k')).toBeNull()
    // Ctrl+K 是应用级命令面板，编辑器必须放行（不拦截、不进和弦）
    expect(resolveEditorKey(key({ key: 'k', ctrlKey: true }), null)).toBeNull()
  })

  it('maps Ctrl+1..9 to editor group focus', () => {
    expect(resolveEditorKey(key({ key: '1', ctrlKey: true }), null)).toEqual({ type: 'focus-group', index: 0 })
    expect(resolveEditorKey(key({ key: '9', metaKey: true }), null)).toEqual({ type: 'focus-group', index: 8 })
  })

  it('ignores unbound and modifier-less keys', () => {
    expect(resolveEditorKey(key({ key: 'z' }), null)).toBeNull()
    expect(resolveEditorKey(key({ key: 'g' }), null)).toBeNull()
    expect(resolveEditorKey(key({ key: 'q', ctrlKey: true }), null)).toBeNull()
    // 编辑器自己的 Ctrl+D / Ctrl+F / Ctrl+/ 等不得被接管
    expect(resolveEditorKey(key({ key: 'd', ctrlKey: true }), null)).toBeNull()
    expect(resolveEditorKey(key({ key: 'f', ctrlKey: true }), null)).toBeNull()
    expect(resolveEditorKey(key({ key: '/', ctrlKey: true }), null)).toBeNull()
  })
  it('formats chord tokens case-insensitively', () => {
    expect(formatKeybinding('mod+k', false)).toBe('Ctrl+K')
    expect(formatKeybinding('mod+k', true)).toBe('Cmd+K')
    expect(formatKeybinding('Mod+Shift+P', false)).toBe('Ctrl+Shift+P')
  })
})
