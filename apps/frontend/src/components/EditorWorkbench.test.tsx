import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from './EditorWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'

const setScrollTop = vi.fn()
const getScrollTop = vi.fn(() => 0)
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, onMount }: any) => {
    const mountedRef = React.useRef(false)
    React.useEffect(() => {
      if (mountedRef.current) return
      mountedRef.current = true
      onMount?.({ getScrollTop, setScrollTop, onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })), getAction: vi.fn(() => ({ run: vi.fn() })), getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })) })
    }, [onMount])
    return React.createElement('textarea', { 'aria-label': 'editor', value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value) })
  },
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { theme: 'dark', fontFamily: 'monospace', fontSize: 14 } }),
}))
vi.mock('@/hooks/useApi', () => ({
  useGitDetect: () => ({ data: { isGitRepo: false } }),
}))

describe('EditorWorkbench', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    useConsoleStore.setState({
      openEditors: [{
        id: 'editor-1',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/index.ts',
        name: 'index.ts',
        absolutePath: '/workspace/src/index.ts',
        language: 'typescript',
        content: 'const value=1',
        savedContent: 'const value=1',
        modifiedAt: '2026-05-29T00:00:00.000Z',
        size: 13,
        dirty: false,
        loading: false,
        saving: false,
        binary: false,
        truncated: false,
      }],
      activeEditorId: 'editor-1',
    } as any)
    setScrollTop.mockClear()
    getScrollTop.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('closes the active editor on ctrl+w', () => {
    render(React.createElement(EditorWorkbench, { onSaveEditor: vi.fn(async () => {}) }))
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(useConsoleStore.getState().openEditors).toHaveLength(0)
    expect(screen.queryByText('/workspace/src/index.ts')).not.toBeInTheDocument()
  })
  it('toggles middle-click auto-scroll mode and exits on escape', () => {
    render(React.createElement(EditorWorkbench, { onSaveEditor: vi.fn(async () => {}) }))
    fireEvent.mouseDown(screen.getByTestId('editor-auto-scroll-zone'), { button: 1, clientX: 140, clientY: 220 })
    expect(screen.getByTestId('editor-auto-scroll-indicator')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('editor-auto-scroll-indicator')).not.toBeInTheDocument()
  })
  it('scrolls editor while middle-click auto-scroll is active', async () => {
    render(React.createElement(EditorWorkbench, { onSaveEditor: vi.fn(async () => {}) }))
    fireEvent.mouseDown(screen.getByTestId('editor-auto-scroll-zone'), { button: 1, clientX: 140, clientY: 220 })
    fireEvent.pointerMove(window, { clientY: 340 })
    await vi.waitFor(() => expect(setScrollTop).toHaveBeenCalled())
  })
})
