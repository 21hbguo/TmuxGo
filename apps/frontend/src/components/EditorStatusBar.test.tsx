import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorStatusBar, type EditorStatusBarActions } from './EditorStatusBar'
import { I18nProvider } from '@/i18n'
import { resetEditorCursorStore, setEditorCursor } from '@/lib/editor-cursor'

function renderBar(overrides: Partial<React.ComponentProps<typeof EditorStatusBar>> = {}) {
  const actions: EditorStatusBarActions = {
    gotoLine: vi.fn(),
    setIndent: vi.fn(),
    toggleEol: vi.fn(),
    toggleWordWrap: vi.fn(),
    cycleWhitespace: vi.fn(),
    toggleMinimap: vi.fn(),
    toggleStickyScroll: vi.fn(),
    toggleAutoSave: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
  }
  const props: React.ComponentProps<typeof EditorStatusBar> = {
    editorId: 'local:root:src/index.ts',
    language: 'typescript',
    dirty: false,
    readOnly: false,
    eol: '\n',
    eolMixed: false,
    indent: { tabSize: 2, insertSpaces: true },
    view: {
      wordWrap: false,
      whitespace: 'boundary',
      minimap: false,
      stickyScroll: true,
      autoSave: false,
      zoomPercent: 100,
    },
    actions,
    ...overrides,
  }
  render(
    <I18nProvider>
      <EditorStatusBar {...props} />
    </I18nProvider>,
  )
  return { actions, props }
}

describe('EditorStatusBar', () => {
  beforeEach(() => {
    resetEditorCursorStore()
  })

  afterEach(() => {
    resetEditorCursorStore()
  })

  it('shows cursor, indent, encoding, eol and language', () => {
    setEditorCursor('local:root:src/index.ts', {
      line: 12,
      column: 7,
      lineCount: 40,
      selections: 1,
      selection: null,
    })
    renderBar()
    expect(screen.getByTestId('editor-status-position').textContent).toBe('行 12, 列 7')
    expect(screen.getByTestId('editor-status-indent').textContent).toBe('空格: 2')
    expect(screen.getByTestId('editor-status-encoding').textContent).toBe('UTF-8')
    expect(screen.getByTestId('editor-status-eol').textContent).toBe('LF')
    expect(screen.getByTestId('editor-status-language').textContent).toBe('TypeScript')
    expect(screen.queryByTestId('editor-status-selection')).toBeNull()
  })

  it('updates only when the cursor store publishes a new frame', async () => {
    renderBar()
    expect(screen.getByTestId('editor-status-position').textContent).toBe('行 1, 列 1')
    setEditorCursor('local:root:src/index.ts', { line: 3, column: 2, lineCount: 9, selections: 1, selection: null })
    await waitFor(() => expect(screen.getByTestId('editor-status-position').textContent).toBe('行 3, 列 2'))
  })

  it('renders selection size and multi-cursor count', () => {
    setEditorCursor('local:root:src/index.ts', {
      line: 2,
      column: 1,
      lineCount: 9,
      selections: 3,
      selection: { lines: 2, chars: 14 },
    })
    renderBar()
    expect(screen.getByTestId('editor-status-selection').textContent).toBe('14 已选 · 3 处')
  })

  it('reports dirty and read-only states', () => {
    const { props } = renderBar({ dirty: true })
    expect(screen.getByTestId('editor-status-state').textContent).toBe('未保存')
    renderBar({ ...props, readOnly: true })
    expect(screen.getAllByTestId('editor-status-state')[1].textContent).toBe('只读')
  })

  it('flags mixed line endings and tab indentation', () => {
    renderBar({ eol: '\r\n', eolMixed: true, indent: { tabSize: 4, insertSpaces: false } })
    expect(screen.getByTestId('editor-status-eol').textContent).toBe('CRLF')
    expect(screen.getByTestId('editor-status-eol').className).toContain('text-warn')
    expect(screen.getByTestId('editor-status-indent').textContent).toBe('制表符')
  })

  it('routes clicks to the right actions', () => {
    const { actions } = renderBar()
    fireEvent.click(screen.getByTestId('editor-status-position'))
    expect(actions.gotoLine).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('editor-status-eol'))
    expect(actions.toggleEol).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('editor-status-wordwrap'))
    expect(actions.toggleWordWrap).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('editor-status-whitespace'))
    expect(actions.cycleWhitespace).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('editor-status-zoom'))
    expect(screen.getByTestId('editor-context-menu')).toBeTruthy()
  })

  it('opens the indent picker and applies a choice', () => {
    const { actions } = renderBar()
    fireEvent.click(screen.getByTestId('editor-status-indent'))
    const menu = screen.getByTestId('editor-context-menu')
    expect(menu).toBeTruthy()
    const spaces4 = [...menu.querySelectorAll('button')].find((button) => button.textContent === '空格: 4')
    expect(spaces4).toBeTruthy()
    fireEvent.click(spaces4!)
    expect(actions.setIndent).toHaveBeenCalledWith({ tabSize: 4, insertSpaces: true })
    expect(screen.queryByTestId('editor-context-menu')).toBeNull()
  })
  it('shows the pending chord hint on the right', () => {
    renderBar({ chordHint: 'Ctrl+K' })
    expect(screen.getByTestId('editor-status-chord').textContent).toContain('Ctrl+K')
  })
  it('hides the chord hint when no chord is pending', () => {
    renderBar({})
    expect(screen.queryByTestId('editor-status-chord')).toBeNull()
  })

  it('offers zoom in/out/reset from the zoom menu', () => {
    const { actions } = renderBar({})
    fireEvent.click(screen.getByTestId('editor-status-zoom'))
    fireEvent.click(screen.getByText('放大编辑器字体'))
    fireEvent.click(screen.getByTestId('editor-status-zoom'))
    fireEvent.click(screen.getByText('缩小编辑器字体'))
    fireEvent.click(screen.getByTestId('editor-status-zoom'))
    fireEvent.click(screen.getByText('重置编辑器字体'))
    expect(actions.zoomIn).toHaveBeenCalledTimes(1)
    expect(actions.zoomOut).toHaveBeenCalledTimes(1)
    expect(actions.resetZoom).toHaveBeenCalledTimes(1)
  })

})
