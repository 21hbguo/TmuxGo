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
      editorPrimaryGroupIds: ['editor-1'],
      editorSecondaryGroupIds: [],
      editorPrimaryId: 'editor-1',
      editorSecondaryId: null,
      editorSplitDirection: null,
      activeEditorSlot: 'primary',
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
      onOpenFileAtPosition: vi.fn(async (file) => file.id),
      onCreateCompare: vi.fn(async () => {}),
    }))
  }
  function createOpenFileHandler() {
    return vi.fn(async (file) => {
      useConsoleStore.getState().openEditor({ ...file, language: 'typescript' })
      return file.id
    })
  }
  function createDataTransfer(payload: Record<string, string>) {
    return {
      effectAllowed: 'all',
      dropEffect: 'copy',
      setData: vi.fn(),
      getData: (type: string) => payload[type] || '',
    }
  }
  function dispatchDragEvent(target: Element, type: 'dragover' | 'drop', dataTransfer: any, coords?: { clientX: number; clientY: number }) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    Object.defineProperty(event, 'clientX', { value: coords?.clientX ?? 0 })
    Object.defineProperty(event, 'clientY', { value: coords?.clientY ?? 0 })
    target.dispatchEvent(event)
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
  it('moves a dragged tab into the secondary group', () => {
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
      ],
      activeEditorId: 'editor-2',
      editorPrimaryGroupIds: ['editor-1'],
      editorSecondaryGroupIds: ['editor-2'],
      editorPrimaryId: 'editor-1',
      editorSecondaryId: 'editor-2',
      editorSplitDirection: 'horizontal',
      activeEditorSlot: 'secondary',
    } as any)
    render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onCreateCompare: vi.fn(async () => {}),
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
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 0, clientY: 0 })
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-2', 'editor-1'])
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([])
  })
  it('opens a dragged file when dropped on an existing tab', async () => {
    const onOpenFile = createOpenFileHandler()
    render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile,
      onCreateCompare: vi.fn(async () => {}),
    }))
    const button = screen.getByRole('button', { name: /index\.ts/i })
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-3',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/drop-tab.ts',
        name: 'drop-tab.ts',
        absolutePath: '/workspace/src/drop-tab.ts',
      }),
    })
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 0, clientY: 0 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-3', name: 'drop-tab.ts' })))
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-3', 'editor-1'])
  })
  it('moves a dragged tab after the hovered tab on right-half drop', () => {
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
          id: 'editor-3',
          hostId: 'local',
          rootId: 'root-workspace',
          rootLabel: 'Workspace',
          rootPath: '/workspace',
          path: 'src/third.ts',
          name: 'third.ts',
          absolutePath: '/workspace/src/third.ts',
          language: 'typescript',
          content: 'const value=3',
          savedContent: 'const value=3',
          modifiedAt: '',
          size: 13,
          dirty: false,
          loading: false,
          saving: false,
          binary: false,
          truncated: false,
          kind: 'file',
        },
      ],
      activeEditorId: 'editor-3',
      editorPrimaryGroupIds: ['editor-1', 'editor-2', 'editor-3'],
      editorSecondaryGroupIds: [],
      editorPrimaryId: 'editor-3',
      editorSecondaryId: null,
      editorSplitDirection: null,
      activeEditorSlot: 'primary',
    } as any)
    render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onCreateCompare: vi.fn(async () => {}),
    }))
    const button = screen.getByRole('button', { name: /other\.ts/i })
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-1',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/index.ts',
        name: 'index.ts',
        absolutePath: '/workspace/src/index.ts',
      }),
    })
    fireEvent.drop(button, { dataTransfer, clientX: 80 })
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-2', 'editor-1', 'editor-3'])
  })
  it('opens a dropped file in the editor area', () => {
    const onOpenFile = vi.fn(async (file) => file.id)
    const onOpenFileAtPosition = vi.fn(async (file) => file.id)
    const view = render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile,
      onOpenFileAtPosition,
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
    dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 500, clientY: 300 })
    expect(onOpenFileAtPosition).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-3', name: 'drop.ts' }), 'center')
  })
  it('opens a dragged file when dropped on the tab strip', async () => {
    const onOpenFile = createOpenFileHandler()
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
      ],
      activeEditorId: 'editor-2',
      editorPrimaryGroupIds: ['editor-1'],
      editorSecondaryGroupIds: ['editor-2'],
      editorPrimaryId: 'editor-1',
      editorSecondaryId: 'editor-2',
      editorSplitDirection: 'horizontal',
      activeEditorSlot: 'secondary',
    } as any)
    render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile,
      onCreateCompare: vi.fn(async () => {}),
    }))
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    strip.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 42, right: 1000, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-4',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/strip.ts',
        name: 'strip.ts',
        absolutePath: '/workspace/src/strip.ts',
      }),
    })
    dispatchDragEvent(strip, 'drop', dataTransfer, { clientX: 500, clientY: 21 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'strip.ts' })))
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual(['editor-2', 'editor-4'])
  })
  it('detects left split drop placement', () => {
    const onOpenFileAtPosition = vi.fn(async (file) => file.id)
    const view = render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onOpenFileAtPosition,
      onCreateCompare: vi.fn(async () => {}),
    }))
    const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as HTMLDivElement
    dropZone.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-4',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/left.ts',
        name: 'left.ts',
        absolutePath: '/workspace/src/left.ts',
      }),
    })
    dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 40, clientY: 300 })
    expect(onOpenFileAtPosition).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'left.ts' }), 'left')
  })
  it('renders split panes from store state', () => {
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
      ],
      activeEditorId: 'editor-2',
      editorPrimaryGroupIds: ['editor-1'],
      editorSecondaryGroupIds: ['editor-2'],
      editorPrimaryId: 'editor-1',
      editorSecondaryId: 'editor-2',
      editorSplitDirection: 'horizontal',
    } as any)
    renderWorkbench()
    expect(screen.getAllByLabelText('editor')).toHaveLength(2)
    expect(screen.getByText('/workspace/src/other.ts')).toBeInTheDocument()
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
      editorPrimaryGroupIds: ['editor-1', 'editor-2', 'compare:editor-1::editor-2'],
      editorSecondaryGroupIds: [],
      editorPrimaryId: 'compare:editor-1::editor-2',
      editorSecondaryId: null,
      editorSplitDirection: null,
    } as any)
    renderWorkbench()
    await vi.waitFor(() => expect(screen.getByTestId('diff-editor')).toBeInTheDocument())
    expect(diffPropsRef.current.at(-1)).toMatchObject({ original: 'const value=1', modified: 'const value=2', language: 'typescript' })
  })
})
