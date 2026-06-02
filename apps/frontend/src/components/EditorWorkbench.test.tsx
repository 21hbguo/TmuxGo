import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from './EditorWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'

const setScrollTop = vi.fn()
const getScrollTop = vi.fn(() => 0)
const diffPropsRef:{ current:any[] } = { current: [] }
vi.mock('next/dynamic', () => ({
  default: (loader: any) => loader.toString().includes('mod.DiffEditor')
    ? ((props: any) => {
        diffPropsRef.current.push(props)
        return React.createElement('div', { 'data-testid': 'diff-editor' })
      })
    : (({ value, onChange, onMount }: any) => {
        const mountedRef = React.useRef(false)
        React.useEffect(() => {
          if (mountedRef.current) return
          mountedRef.current = true
          onMount?.({ getScrollTop, setScrollTop, onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })), getAction: vi.fn(() => ({ run: vi.fn() })), getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })) })
        }, [onMount])
        return React.createElement('textarea', { 'aria-label': 'editor', value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value) })
      }),
}))
vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null,
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { theme: 'dark', fontFamily: 'monospace', fontSize: 14 } }),
}))
vi.mock('@/hooks/useApi', () => ({
  useGitDetect: () => ({ data: { isGitRepo: false } }),
}))

describe('EditorWorkbench', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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
        kind: 'file',
      }],
      activeEditorId: 'editor-1',
    } as any)
    setScrollTop.mockClear()
    getScrollTop.mockClear()
    diffPropsRef.current = []
  })
  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function renderWorkbench() {
    return render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onCreateCompare: vi.fn(async () => {}),
    }))
  }
  function createDataTransfer(payload: Record<string, string>) {
    return {
      effectAllowed: 'all',
      dropEffect: 'copy',
      setData: vi.fn(),
      getData: (type: string) => payload[type] || '',
    }
  }

  it('closes the active editor on ctrl+w', () => {
    renderWorkbench()
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(useConsoleStore.getState().openEditors).toHaveLength(0)
    expect(screen.queryByText('/workspace/src/index.ts')).not.toBeInTheDocument()
  })
  it('toggles middle-click auto-scroll mode and exits on escape', () => {
    renderWorkbench()
    fireEvent.mouseDown(screen.getByTestId('editor-auto-scroll-zone'), { button: 1, clientX: 140, clientY: 220 })
    expect(screen.getByTestId('editor-auto-scroll-indicator')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('editor-auto-scroll-indicator')).not.toBeInTheDocument()
  })
  it('scrolls editor while middle-click auto-scroll is active', async () => {
    renderWorkbench()
    fireEvent.mouseDown(screen.getByTestId('editor-auto-scroll-zone'), { button: 1, clientX: 140, clientY: 220 })
    fireEvent.pointerMove(window, { clientY: 340 })
    vi.advanceTimersByTime(32)
    await vi.waitFor(() => expect(setScrollTop).toHaveBeenCalled())
  })
  it('creates compare when dropping a file onto an editor tab', () => {
    const onCreateCompare = vi.fn(async () => {})
    render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onCreateCompare,
    }))
    const button = screen.getByRole('button', { name: /index\.ts/i })
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-2',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/other.ts',
        name: 'other.ts',
        absolutePath: '/workspace/src/other.ts',
      }),
    })
    fireEvent.drop(button, { dataTransfer })
    expect(onCreateCompare).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-2', name: 'other.ts' }), 'editor-1')
  })
  it('opens a dropped file in the editor area', () => {
    const onOpenFile = vi.fn(async (file) => file.id)
    const view = render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile,
      onCreateCompare: vi.fn(async () => {}),
    }))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-3',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/drop.ts',
        name: 'drop.ts',
        absolutePath: '/workspace/src/drop.ts',
      }),
    })
    const dropZone = view.container.querySelector('section > .min-h-0.flex-1.bg-bg-0') as Element
    fireEvent.dragOver(dropZone, { dataTransfer })
    expect(screen.getByText('editor.dropOpen')).toBeInTheDocument()
    fireEvent.drop(dropZone, { dataTransfer })
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-3', name: 'drop.ts' }))
  })
  it('renders compare editor content for compare tabs', async () => {
    useConsoleStore.setState({
      openEditors: [
        ...useConsoleStore.getState().openEditors,
        {
          id: 'editor-2',
          hostId: 'local',
          rootId: 'root-workspace',
          rootLabel: 'Workspace',
          rootPath: '/workspace',
          path: 'src/other.ts',
          name: 'other.ts',
          absolutePath: '/workspace/src/other.ts',
          language: 'typescript',
          content: 'const value=2',
          savedContent: 'const value=2',
          modifiedAt: '',
          size: 13,
          dirty: false,
          loading: false,
          saving: false,
          binary: false,
          truncated: false,
          kind: 'file',
        },
        {
          id: 'compare:editor-1::editor-2',
          hostId: 'local',
          rootId: 'root-workspace',
          rootLabel: 'Workspace',
          rootPath: '/workspace',
          path: 'src/index.ts',
          name: 'index.ts <> other.ts',
          absolutePath: '',
          language: 'typescript',
          content: '',
          savedContent: '',
          modifiedAt: '',
          size: 0,
          dirty: false,
          loading: false,
          saving: false,
          binary: false,
          truncated: false,
          kind: 'compare',
          compareLeftId: 'editor-1',
          compareRightId: 'editor-2',
        },
      ],
      activeEditorId: 'compare:editor-1::editor-2',
    } as any)
    renderWorkbench()
    await vi.waitFor(() => expect(screen.getByTestId('diff-editor')).toBeInTheDocument())
    expect(diffPropsRef.current.at(-1)).toMatchObject({ original: 'const value=1', modified: 'const value=2', language: 'typescript' })
  })
})
