import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from './EditorWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { EditorGroupState, EditorLayoutNode, EditorLayoutSplit } from '@/stores/useConsoleStore'

const setScrollTop = vi.fn()
const getScrollTop = vi.fn(() => 0)
const setScrollLeft = vi.fn()
const getScrollLeft = vi.fn(() => 0)
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
          onMount?.({ getScrollTop, setScrollTop, getScrollLeft, setScrollLeft, onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })), getAction: vi.fn(() => ({ run: vi.fn() })), getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })) })
        }, [onMount])
        return React.createElement('textarea', { 'aria-label': 'editor', value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value), onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => {
          if (event.defaultPrevented) return
          const text = event.dataTransfer?.getData('text/plain') || ''
          if (text) onChange?.(`${value}${text}`)
        } })
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
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => {
    if (key === 'editor.clear') return 'Clear'
    if (key === 'editor.find') return 'Find'
    if (key === 'editor.format') return 'Format'
    if (key === 'editor.preview') return 'Preview'
    if (key === 'editor.saved') return 'Saved'
    if (key === 'editor.save') return 'Save'
    if (key === 'editor.saving') return 'Saving'
    if (key === 'common.confirm') return 'Confirm'
    if (key === 'common.cancel') return 'Cancel'
    return key
  } }),
}))

function createEditor(id: string, path: string, content: string, overrides: Record<string, any> = {}) {
  const name = path.split('/').pop() || path
  return {
    id,
    hostId: 'local',
    rootId: 'root-workspace',
    rootLabel: 'Workspace',
    rootPath: '/workspace',
    path,
    name,
    absolutePath: `/workspace/${path}`,
    language: 'typescript',
    content,
    savedContent: content,
    modifiedAt: '',
    size: content.length,
    dirty: false,
    loading: false,
    saving: false,
    binary: false,
    truncated: false,
    kind: 'file',
    ...overrides,
  }
}
function createCompareEditor(id: string, leftId: string, rightId: string) {
  return {
    id,
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
    compareLeftId: leftId,
    compareRightId: rightId,
  }
}
function createGroup(id: string, editorIds: string[], activeEditorId: string | null = editorIds.at(-1) || null): EditorGroupState {
  return { id, editorIds, activeEditorId }
}
function createLeaf(id: string, groupId: string): EditorLayoutNode {
  return { id, type: 'group', groupId }
}
function createSplit(id: string, direction: 'horizontal' | 'vertical', first: EditorLayoutNode, second: EditorLayoutNode, ratio = 0.5): EditorLayoutSplit {
  return { id, type: 'split', direction, ratio, first, second }
}
function collectGroupIds(node: EditorLayoutNode | null): string[] {
  if (!node) return []
  if (node.type === 'group') return [node.groupId]
  return [...collectGroupIds(node.first), ...collectGroupIds(node.second)]
}
function setWorkbenchState({ openEditors, activeEditorId, editorGroups, editorLayout, activeEditorGroupId }: { openEditors: any[]; activeEditorId: string | null; editorGroups: EditorGroupState[]; editorLayout: EditorLayoutNode | null; activeEditorGroupId: string | null }) {
  const orderedGroupIds = collectGroupIds(editorLayout)
  const primaryGroup = editorGroups.find((group) => group.id === orderedGroupIds[0]) || editorGroups[0] || null
  const secondaryGroup = editorGroups.find((group) => group.id === orderedGroupIds[1]) || null
  const rootSplit = editorLayout?.type === 'split' ? editorLayout : null
  useConsoleStore.setState({
    openEditors,
    activeEditorId,
    editorGroups,
    editorLayout,
    activeEditorGroupId,
    editorPrimaryGroupIds: primaryGroup?.editorIds || [],
    editorSecondaryGroupIds: secondaryGroup?.editorIds || [],
    editorPrimaryId: primaryGroup?.activeEditorId || null,
    editorSecondaryId: secondaryGroup?.activeEditorId || null,
    editorSplitDirection: secondaryGroup ? rootSplit?.direction || 'horizontal' : null,
    editorSplitRatio: secondaryGroup ? rootSplit?.ratio || 0.5 : 0.5,
    activeEditorSlot: secondaryGroup && activeEditorGroupId === secondaryGroup.id ? 'secondary' : 'primary',
  } as any)
}
function createDataTransfer(payload: Record<string, string>) {
  return {
    effectAllowed: 'all',
    dropEffect: 'copy',
    types: Object.keys(payload),
    setData: vi.fn(),
    getData: (type: string) => payload[type] || '',
  }
}
function createDraggedFile(id: string, path: string) {
  const name = path.split('/').pop() || path
  return {
    id,
    hostId: 'local',
    rootId: 'root-workspace',
    rootLabel: 'Workspace',
    rootPath: '/workspace',
    path,
    name,
    absolutePath: `/workspace/${path}`,
  }
}
function createFileDataTransfer(id: string, path: string) {
  const file = createDraggedFile(id, path)
  return createDataTransfer({
    'application/x-tmuxgo-file': JSON.stringify(file),
    'text/plain': file.absolutePath,
  })
}
function createRect(width = 1000, height = 600) {
  return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}
async function dispatchDragEvent(target: Element, type: 'dragover' | 'drop', dataTransfer: any, coords?: { clientX: number; clientY: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: coords?.clientX ?? 0 })
  Object.defineProperty(event, 'clientY', { value: coords?.clientY ?? 0 })
  await act(async () => {
    target.dispatchEvent(event)
  })
}

describe('EditorWorkbench', () => {
  const editor1 = createEditor('editor-1', 'src/index.ts', 'const value=1', { modifiedAt: '2026-05-29T00:00:00.000Z', size: 13 })
  const editor2 = createEditor('editor-2', 'src/other.ts', 'const value=2')
  const editor3 = createEditor('editor-3', 'src/third.ts', 'const value=3')
  const editor4 = createEditor('editor-4', 'src/fourth.ts', 'const value=4')
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    setWorkbenchState({
      openEditors: [editor1],
      activeEditorId: editor1.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    setScrollTop.mockClear()
    getScrollTop.mockClear()
    setScrollLeft.mockClear()
    getScrollLeft.mockClear()
    diffPropsRef.current = []
  })
  afterEach(() => {
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function renderWorkbench(overrides: Partial<React.ComponentProps<typeof EditorWorkbench>> = {}) {
    return render(React.createElement(EditorWorkbench, {
      onSaveEditor: vi.fn(async () => {}),
      onOpenFile: vi.fn(async (file) => file.id),
      onOpenFileAtPosition: vi.fn(async (file) => file.id),
      onCreateCompare: vi.fn(async () => {}),
      ...overrides,
    }))
  }
  function createOpenFileHandler() {
    return vi.fn(async (file) => {
      useConsoleStore.getState().openEditor({ ...file, language: 'typescript' })
      useConsoleStore.getState().setEditorLoaded(file.id, { content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: false, saving: false, binary: false, truncated: false })
      return file.id
    })
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
  it('scrolls editor horizontally while middle-click auto-scroll is active', async () => {
    renderWorkbench()
    fireEvent.mouseDown(screen.getByTestId('editor-auto-scroll-zone'), { button: 1, clientX: 140, clientY: 220 })
    fireEvent.pointerMove(window, { clientX: 280, clientY: 220 })
    vi.advanceTimersByTime(32)
    await vi.waitFor(() => expect(setScrollLeft).toHaveBeenCalled())
  })
  it('keeps single-group editor surface stretched to the available height', () => {
    const { container } = renderWorkbench()
    const body = container.querySelector('section[data-editor-drop] > .relative.min-h-0.flex-1.bg-bg-0 > .flex.h-full.min-h-0.flex-col') as HTMLDivElement | null
    const pane = body?.firstElementChild as HTMLDivElement | null
    const surface = pane?.querySelector('button.relative.min-h-0.min-w-0.flex-1.overflow-hidden.text-left') as HTMLButtonElement | null
    expect(body).toBeTruthy()
    expect(pane).toBeTruthy()
    expect(surface).toBeTruthy()
    expect(body?.className).toContain('h-full')
    expect(pane?.className).toContain('flex-1')
    expect(surface?.className).toContain('flex-1')
  })
  it('clears all opened editors from the toolbar button', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id), createGroup('group-3', [editor3.id], editor3.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3'))),
      activeEditorGroupId: 'group-3',
    })
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(useConsoleStore.getState().openEditors).toHaveLength(0)
  })
  it('renders compact tab strip height for single and split groups', () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench()
    const strips = [
      screen.getByTestId('editor-group-primary') as HTMLDivElement,
      screen.getByTestId('editor-group-secondary') as HTMLDivElement,
    ]
    for (const strip of strips) {
      expect(strip.className).toContain('min-h-7')
    }
    const tabs = ['index.ts', 'other.ts'].map((name) => screen.getByRole('button', { name }).parentElement as HTMLDivElement)
    for (const tab of tabs) {
      expect(tab.className).toContain('h-7')
    }
  })
  it('moves a dragged tab into the primary group and collapses the source split', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench()
    const button = screen.getByRole('button', { name: 'index.ts' })
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: editor2.id,
        hostId: editor2.hostId,
        rootId: editor2.rootId,
        rootLabel: editor2.rootLabel,
        rootPath: editor2.rootPath,
        path: editor2.path,
        name: editor2.name,
        absolutePath: editor2.absolutePath,
      }),
      'text/plain': editor2.absolutePath,
    })
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    await dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 0, clientY: 0 })
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual([editor2.id, editor1.id])
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([])
  })
  it('opens a dragged file when dropped on an existing tab', async () => {
    const onOpenFile = createOpenFileHandler()
    renderWorkbench({ onOpenFile })
    const button = screen.getByRole('button', { name: 'index.ts' })
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-4',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/drop-tab.ts',
        name: 'drop-tab.ts',
        absolutePath: '/workspace/src/drop-tab.ts',
      }),
      'text/plain': '/workspace/src/drop-tab.ts',
    })
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    await dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 0, clientY: 0 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'drop-tab.ts' })))
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-4', editor1.id])
  })
  it('moves a dragged tab after the hovered tab on right-half drop', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [createGroup('group-1', [editor1.id, editor2.id, editor3.id], editor3.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const button = screen.getByRole('button', { name: 'other.ts' })
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 42, right: 100, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: editor1.id,
        hostId: editor1.hostId,
        rootId: editor1.rootId,
        rootLabel: editor1.rootLabel,
        rootPath: editor1.rootPath,
        path: editor1.path,
        name: editor1.name,
        absolutePath: editor1.absolutePath,
      }),
      'text/plain': editor1.absolutePath,
    })
    await dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 80, clientY: 0 })
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual([editor2.id, editor1.id, editor3.id])
  })
  it('moves a dragged tab across a nested 4-group layout and collapses the emptied group', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3, editor4],
      activeEditorId: editor4.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id), createGroup('group-3', [editor3.id], editor3.id), createGroup('group-4', [editor4.id], editor4.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createSplit('layout-5', 'horizontal', createLeaf('layout-6', 'group-3'), createLeaf('layout-7', 'group-4')))),
      activeEditorGroupId: 'group-4',
    })
    const { container } = renderWorkbench()
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    strip.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 42, right: 1000, bottom: 42, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: editor4.id,
        hostId: editor4.hostId,
        rootId: editor4.rootId,
        rootLabel: editor4.rootLabel,
        rootPath: editor4.rootPath,
        path: editor4.path,
        name: editor4.name,
        absolutePath: editor4.absolutePath,
      }),
      'text/plain': editor4.absolutePath,
    })
    await dispatchDragEvent(strip, 'drop', dataTransfer, { clientX: 500, clientY: 21 })
    const state = useConsoleStore.getState()
    expect(state.editorGroups).toHaveLength(3)
    expect(collectGroupIds(state.editorLayout)).toEqual(['group-1', 'group-2', 'group-3'])
    expect(state.editorGroups.find((group) => group.id === 'group-2')?.editorIds).toEqual([editor2.id, editor4.id])
    expect(state.activeEditorId).toBe(editor4.id)
    expect(state.activeEditorGroupId).toBe('group-2')
    expect(screen.queryByTestId('editor-group-group-4')).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
    const splits = Array.from(container.querySelectorAll('[data-editor-split]')) as HTMLDivElement[]
    expect(splits).toHaveLength(2)
    for (const split of splits) {
      expect(split.className).toContain('flex-1')
      expect(split.className).toContain('min-w-0')
      expect(split.className).toContain('w-full')
    }
  })
  it('opens a dropped file in the editor area center group', async () => {
    const onOpenFile = createOpenFileHandler()
    const view = renderWorkbench({ onOpenFile })
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-4',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/drop.ts',
        name: 'drop.ts',
        absolutePath: '/workspace/src/drop.ts',
      }),
      'text/plain': '/workspace/src/drop.ts',
    })
    const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as Element
    ;(dropZone as HTMLDivElement).getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    await dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 500, clientY: 300 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'drop.ts' })))
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual([editor1.id, 'editor-4'])
  })
  it('does not insert a dragged file path into editor content when dropping on the editor surface', async () => {
    const onOpenFile = createOpenFileHandler()
    renderWorkbench({ onOpenFile })
    const textarea = screen.getByLabelText('editor') as HTMLTextAreaElement
    const pane = textarea.closest('button') as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => createRect())
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-12',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/surface.ts',
        name: 'surface.ts',
        absolutePath: '/workspace/src/surface.ts',
      }),
      'text/plain': '/workspace/src/surface.ts',
    })
    await dispatchDragEvent(textarea, 'drop', dataTransfer, { clientX: 500, clientY: 300 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-12', name: 'surface.ts' })))
    expect(useConsoleStore.getState().openEditors.find((item) => item.id === editor1.id)?.content).toBe('const value=1')
    expect(useConsoleStore.getState().openEditors.find((item) => item.id === editor1.id)?.dirty).toBe(false)
  })
  it('opens a dragged file when dropped on the secondary tab strip', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench({ onOpenFile })
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
      'text/plain': '/workspace/src/strip.ts',
    })
    await dispatchDragEvent(strip, 'drop', dataTransfer, { clientX: 500, clientY: 21 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'strip.ts' })))
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([editor2.id, 'editor-4'])
  })
  it('splits the active group when dropped on the left edge of the editor area', async () => {
    const onOpenFile = createOpenFileHandler()
    const view = renderWorkbench({ onOpenFile })
    const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as HTMLDivElement
    dropZone.getBoundingClientRect = vi.fn(() => createRect())
    const dataTransfer = createFileDataTransfer('editor-4', 'src/left.ts')
    await dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 40, clientY: 300 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'left.ts' })))
    expect(useConsoleStore.getState().editorSplitDirection).toBe('horizontal')
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-4'])
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([editor1.id])
  })
  it.each([
    { title: 'right edge', id: 'editor-7', path: 'src/right.ts', clientX: 960, clientY: 300, direction: 'horizontal', first: 'group-1', second: 'new' },
    { title: 'top edge', id: 'editor-8', path: 'src/top-root.ts', clientX: 500, clientY: 40, direction: 'vertical', first: 'new', second: 'group-1' },
    { title: 'bottom edge', id: 'editor-9', path: 'src/bottom-root.ts', clientX: 500, clientY: 560, direction: 'vertical', first: 'group-1', second: 'new' },
  ])('splits the active group from the $title of the editor area', async ({ id, path, clientX, clientY, direction, first, second }) => {
    const onOpenFile = createOpenFileHandler()
    const view = renderWorkbench({ onOpenFile })
    const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as HTMLDivElement
    dropZone.getBoundingClientRect = vi.fn(() => createRect())
    await dispatchDragEvent(dropZone, 'drop', createFileDataTransfer(id, path), { clientX, clientY })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id, name: path.split('/').pop() })))
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes(id))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe(direction)
    expect(state.editorLayout?.type === 'split' && state.editorLayout.first.type === 'group' ? state.editorLayout.first.groupId : null).toBe(first === 'new' ? newGroupId : first)
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'group' ? state.editorLayout.second.groupId : null).toBe(second === 'new' ? newGroupId : second)
    expect(screen.getAllByLabelText('editor')).toHaveLength(2)
  })
  it('splits the secondary group vertically when dropped on its top edge', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-5',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/top.ts',
        name: 'top.ts',
        absolutePath: '/workspace/src/top.ts',
      }),
      'text/plain': '/workspace/src/top.ts',
    })
    await dispatchDragEvent(pane, 'drop', dataTransfer, { clientX: 500, clientY: 40 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-5', name: 'top.ts' })))
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-5'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe('horizontal')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' ? state.editorLayout.second.direction : null).toBe('vertical')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.first.type === 'group' ? state.editorLayout.second.first.groupId : null).toBe(newGroupId)
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.second.type === 'group' ? state.editorLayout.second.second.groupId : null).toBe('group-2')
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
    const splits = Array.from(container.querySelectorAll('[data-editor-split]')) as HTMLDivElement[]
    expect(splits).toHaveLength(2)
  })
  it('splits the secondary group vertically when dropped on its bottom edge', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect))
    const dataTransfer = createDataTransfer({
      'application/x-tmuxgo-file': JSON.stringify({
        id: 'editor-6',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/bottom.ts',
        name: 'bottom.ts',
        absolutePath: '/workspace/src/bottom.ts',
      }),
      'text/plain': '/workspace/src/bottom.ts',
    })
    await dispatchDragEvent(pane, 'drop', dataTransfer, { clientX: 500, clientY: 560 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-6', name: 'bottom.ts' })))
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-6'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe('horizontal')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' ? state.editorLayout.second.direction : null).toBe('vertical')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.first.type === 'group' ? state.editorLayout.second.first.groupId : null).toBe('group-2')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.second.type === 'group' ? state.editorLayout.second.second.groupId : null).toBe(newGroupId)
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
  })
  it('splits the middle group vertically in a nested 3-group layout and reaches 4 groups', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id), createGroup('group-3', [editor3.id], editor3.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3'))),
      activeEditorGroupId: 'group-3',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => createRect())
    await dispatchDragEvent(pane, 'drop', createFileDataTransfer('editor-10', 'src/nested-top.ts'), { clientX: 500, clientY: 40 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-10', name: 'nested-top.ts' })))
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-10'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorGroups).toHaveLength(4)
    expect(collectGroupIds(state.editorLayout)).toEqual(['group-1', newGroupId as string, 'group-2', 'group-3'])
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.first.type === 'split' ? state.editorLayout.second.first.direction : null).toBe('vertical')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.first.type === 'split' && state.editorLayout.second.first.first.type === 'group' ? state.editorLayout.second.first.first.groupId : null).toBe(newGroupId)
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.first.type === 'split' && state.editorLayout.second.first.second.type === 'group' ? state.editorLayout.second.first.second.groupId : null).toBe('group-2')
    expect(screen.getAllByLabelText('editor')).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('[data-editor-split]'))).toHaveLength(3)
  })
  it('splits the last group horizontally in a nested 3-group layout and reaches 4 groups', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id), createGroup('group-3', [editor3.id], editor3.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3'))),
      activeEditorGroupId: 'group-3',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-group-3') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => createRect())
    await dispatchDragEvent(pane, 'drop', createFileDataTransfer('editor-11', 'src/nested-right.ts'), { clientX: 960, clientY: 300 })
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-11', name: 'nested-right.ts' })))
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-11'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorGroups).toHaveLength(4)
    expect(collectGroupIds(state.editorLayout)).toEqual(['group-1', 'group-2', 'group-3', newGroupId as string])
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.second.type === 'split' ? state.editorLayout.second.second.direction : null).toBe('horizontal')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.second.type === 'split' && state.editorLayout.second.second.first.type === 'group' ? state.editorLayout.second.second.first.groupId : null).toBe('group-3')
    expect(state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split' && state.editorLayout.second.second.type === 'split' && state.editorLayout.second.second.second.type === 'group' ? state.editorLayout.second.second.second.groupId : null).toBe(newGroupId)
    expect(screen.getAllByLabelText('editor')).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('[data-editor-split]'))).toHaveLength(3)
  })
  it('renders split panes from store state', () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createLeaf('layout-3', 'group-2')),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench()
    expect(screen.getAllByLabelText('editor')).toHaveLength(2)
    expect(screen.getByText('/workspace/src/other.ts')).toBeInTheDocument()
  })
  it('keeps nested split containers stretched for 3-group layouts', () => {
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [createGroup('group-1', [editor1.id], editor1.id), createGroup('group-2', [editor2.id], editor2.id), createGroup('group-3', [editor3.id], editor3.id)],
      editorLayout: createSplit('layout-1', 'horizontal', createLeaf('layout-2', 'group-1'), createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3'))),
      activeEditorGroupId: 'group-3',
    })
    const { container } = renderWorkbench()
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
    const splits = Array.from(container.querySelectorAll('[data-editor-split]')) as HTMLDivElement[]
    expect(splits).toHaveLength(2)
    for (const split of splits) {
      expect(split.className).toContain('flex-1')
      expect(split.className).toContain('min-w-0')
      expect(split.className).toContain('w-full')
    }
  })
  it('renders compare editor content for compare tabs', async () => {
    const compareEditor = createCompareEditor('compare:editor-1::editor-2', editor1.id, editor2.id)
    setWorkbenchState({
      openEditors: [editor1, editor2, compareEditor],
      activeEditorId: compareEditor.id,
      editorGroups: [createGroup('group-1', [editor1.id, editor2.id, compareEditor.id], compareEditor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    await vi.waitFor(() => expect(screen.getByTestId('diff-editor')).toBeInTheDocument())
    expect(diffPropsRef.current.at(-1)).toMatchObject({ original: 'const value=1', modified: 'const value=2', language: 'typescript' })
  })
})
