import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorBreadcrumbs } from './EditorBreadcrumbs'
import { I18nProvider } from '@/i18n'
import type { EditorSymbol } from '@/lib/editor-outline'
import { resetEditorCursorStore, setEditorCursor } from '@/lib/editor-cursor'

const EDITOR_ID = 'local:root:EditorWorkbench.tsx'
const symbol = (name: string, line: number, kind: EditorSymbol['kind'] = 'function', depth = 0): EditorSymbol => ({
  name,
  kind,
  line,
  column: 1,
  depth,
})

function renderCrumbs(overrides: Partial<React.ComponentProps<typeof EditorBreadcrumbs>> = {}) {
  const props: React.ComponentProps<typeof EditorBreadcrumbs> = {
    editorId: EDITOR_ID,
    rootLabel: 'Workspace',
    directories: ['src', 'components'],
    fileName: 'EditorWorkbench.tsx',
    symbols: [symbol('renderPane', 420), symbol('inner', 470, 'method', 1), symbol('other', 600)],
    onOpenSymbolPicker: vi.fn(),
    onRevealDirectory: vi.fn(),
    onJumpToSymbol: vi.fn(),
    ...overrides,
  }
  render(
    <I18nProvider>
      <EditorBreadcrumbs {...props} />
    </I18nProvider>,
  )
  return props
}

const setCursorLine = (line: number) =>
  setEditorCursor(EDITOR_ID, { line, column: 1, lineCount: 700, selections: 1, selection: null })

describe('EditorBreadcrumbs', () => {
  beforeEach(() => resetEditorCursorStore())
  afterEach(() => resetEditorCursorStore())

  it('renders root, directories, file and the symbol trail for the cursor line', () => {
    setCursorLine(480)
    renderCrumbs()
    const nav = screen.getByTestId('editor-breadcrumbs')
    expect(nav.textContent).toContain('Workspace')
    expect(nav.textContent).toContain('components')
    expect(screen.getByTestId('editor-breadcrumb-file').textContent).toBe('EditorWorkbench.tsx')
    expect(screen.getByTestId('editor-breadcrumb-symbol-0').textContent).toBe('renderPane')
    expect(screen.getByTestId('editor-breadcrumb-symbol-1').textContent).toBe('inner')
  })

  it('reveals the clicked directory with its full relative path', () => {
    const props = renderCrumbs()
    fireEvent.click(screen.getByText('components'))
    expect(props.onRevealDirectory).toHaveBeenCalledWith('src/components')
  })

  it('opens the symbol picker from the file crumb', () => {
    const props = renderCrumbs()
    fireEvent.click(screen.getByTestId('editor-breadcrumb-file'))
    expect(props.onOpenSymbolPicker).toHaveBeenCalled()
  })

  it('jumps to a symbol line', () => {
    setCursorLine(480)
    const props = renderCrumbs()
    fireEvent.click(screen.getByTestId('editor-breadcrumb-symbol-1'))
    expect(props.onJumpToSymbol).toHaveBeenCalledWith(expect.objectContaining({ name: 'inner', line: 470 }))
  })

  it('collapses deep directory chains but keeps both ends', () => {
    renderCrumbs({ directories: ['apps', 'frontend', 'src', 'components', 'editor'] })
    const nav = screen.getByTestId('editor-breadcrumbs')
    expect(nav.textContent).toContain('apps')
    expect(nav.textContent).toContain('editor')
    expect(nav.textContent).not.toContain('frontend')
  })

  it('renders just the file when the symbol table is empty', () => {
    renderCrumbs({ symbols: [] })
    expect(screen.getByTestId('editor-breadcrumb-file')).toBeTruthy()
    expect(screen.queryByTestId('editor-breadcrumb-symbol-0')).toBeNull()
  })

  it('drops the trail before the first symbol', () => {
    setCursorLine(10)
    renderCrumbs()
    expect(screen.queryByTestId('editor-breadcrumb-symbol-0')).toBeNull()
  })
})
