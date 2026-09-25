import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from './EditorWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { EditorGroupState, EditorLayoutNode, EditorLayoutSplit } from '@/stores/useConsoleStore'

const liveEditors = vi.hoisted(() => new Map<string, any>())
const resolveDefinitionMock = vi.hoisted(() => vi.fn())
const openFileInEditorMock = vi.hoisted(() => vi.fn())
const setScrollTop = vi.fn()
const getScrollTop = vi.fn(() => 0)
const setScrollLeft = vi.fn()
const getScrollLeft = vi.fn(() => 0)
const diffPropsRef: { current: any[] } = { current: [] }
const monacoMouseDownRef: { current: ((event: any) => void) | null } = { current: null }
const monacoCursorHandlerRef: { current: ((event: any) => void) | null } = { current: null }
const editorInstanceMocks = vi.hoisted(() => ({
  setPosition: vi.fn(),
  setSelection: vi.fn(),
  revealLineInCenter: vi.fn(),
  focus: vi.fn(),
}))
vi.mock('@/lib/code-navigation', () => ({
  resolveEditorDefinition: (...args: any[]) => resolveDefinitionMock(...args),
  warmupCodeNavigation: () => {},
}))
vi.mock('@/lib/editor-open', () => ({
  OPEN_EDITOR_LOCATION_EVENT: 'tmuxgo-open-editor-location',
  openFileInEditor: (...args: any[]) => openFileInEditorMock(...args),
}))
vi.mock('@/lib/dynamic', async () => {
  // CsvTable 也走 dynamic()：返回真实组件，其余 monaco loader 维持原有替身
  const { CsvTable } = await import('./CsvTable')
  // 有状态 Monaco 替身：每个 path 一个存活实例，保留光标/选区/滚动与行内容，支持 dispose→remount
  const MonacoStub = ({ value, onChange, onMount, path }: any) => {
    const valueRef = React.useRef(value)
    valueRef.current = value
    React.useEffect(() => {
      let position = { lineNumber: 1, column: 1 }
      let selection: any = null
      let scrollTop = 0
      let scrollLeft = 0
      // 对齐真实卸载顺序：@monaco-editor/react 先 dispose model 再 dispose editor，
      // 之后 onDidDispose 回调里读到的是无 model 死值（getPosition null、getScrollTop -1）
      let disposed = false
      let cursorHandler: ((event: any) => void) | undefined
      let scrollHandler: ((event: any) => void) | undefined
      const disposalHandlers: (() => void)[] = []
      const instance = {
        getPosition: () => (disposed ? null : { ...position }),
        setPosition: (next: any) => {
          position = { lineNumber: next.lineNumber, column: next.column }
          editorInstanceMocks.setPosition(next)
          cursorHandler?.({ position })
        },
        getSelection: () => (disposed ? null : selection ? { ...selection } : null),
        setSelection: (next: any) => {
          selection = { ...next }
          position = { lineNumber: next.endLineNumber, column: next.endColumn }
          editorInstanceMocks.setSelection(next)
          cursorHandler?.({ position })
        },
        getScrollTop: () => (disposed ? -1 : scrollTop),
        setScrollTop: (next: number) => {
          scrollTop = next
          setScrollTop(next)
          scrollHandler?.({ scrollTop, scrollLeft })
        },
        getScrollLeft: () => (disposed ? -1 : scrollLeft),
        setScrollLeft: (next: number) => {
          scrollLeft = next
          setScrollLeft(next)
          scrollHandler?.({ scrollTop, scrollLeft })
        },
        getModel: () => ({
          getLineCount: () => valueRef.current.split('\n').length,
          getLineMaxColumn: (line: number) => (valueRef.current.split('\n')[line - 1] || '').length + 1,
        }),
        revealPositionInCenter: vi.fn(),
        revealLineInCenter: (line: number) => editorInstanceMocks.revealLineInCenter(line),
        focus: () => editorInstanceMocks.focus(),
        onDidChangeCursorPosition: (handler: (event: any) => void) => {
          cursorHandler = (event: any) => {
            position = { ...event.position }
            handler(event)
          }
          monacoCursorHandlerRef.current = cursorHandler
          return { dispose: vi.fn() }
        },
        onDidScrollChange: (handler: (event: any) => void) => {
          scrollHandler = handler
          return { dispose: vi.fn() }
        },
        onDidDispose: (handler: () => void) => {
          disposalHandlers.push(handler)
          return { dispose: vi.fn() }
        },
        onMouseDown: (handler: (event: any) => void) => {
          monacoMouseDownRef.current = handler
          return { dispose: vi.fn() }
        },
        getAction: vi.fn(() => ({ run: vi.fn() })),
      }
      liveEditors.set(path, instance)
      onMount?.(instance)
      return () => {
        disposed = true
        disposalHandlers.forEach((handler) => handler())
        liveEditors.delete(path)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return React.createElement('textarea', {
      'aria-label': 'editor',
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value),
      onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => {
        if (event.defaultPrevented) return
        const text = event.dataTransfer?.getData('text/plain') || ''
        if (text) onChange?.(`${value}${text}`)
      },
    })
  }
  return {
    default: (loader: any) => {
      const src = loader.toString()
      if (src.includes('mod.DiffEditor'))
        return (props: any) => {
          diffPropsRef.current.push(props)
          return React.createElement('div', { 'data-testid': 'diff-editor' })
        }
      if (src.includes('CsvTable')) return (props: any) => React.createElement(CsvTable, props)
      return MonacoStub
    },
  }
})
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
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'editor.clear') return 'Clear'
      if (key === 'editor.find') return 'Find'
      if (key === 'editor.back') return 'Back'
      if (key === 'editor.forward') return 'Forward'
      if (key === 'editor.definition') return 'Go to definition'
      if (key === 'editor.preview') return 'Preview'
      if (key === 'editor.syncPreview') return 'Sync preview'
      if (key === 'editor.saved') return 'Saved'
      if (key === 'editor.save') return 'Save'
      if (key === 'editor.saving') return 'Saving'
      if (key === 'common.confirm') return 'Confirm'
      if (key === 'common.cancel') return 'Cancel'
      if (key === 'common.retry') return 'Retry'
      if (key === 'common.close') return 'Close'
      if (key === 'editor.saveFailedKept') return 'Save failed; changes are kept'
      return key
    },
  }),
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
function createGroup(
  id: string,
  editorIds: string[],
  activeEditorId: string | null = editorIds.at(-1) || null,
): EditorGroupState {
  return { id, editorIds, activeEditorId }
}
function createLeaf(id: string, groupId: string): EditorLayoutNode {
  return { id, type: 'group', groupId }
}
function createSplit(
  id: string,
  direction: 'horizontal' | 'vertical',
  first: EditorLayoutNode,
  second: EditorLayoutNode,
  ratio = 0.5,
): EditorLayoutSplit {
  return { id, type: 'split', direction, ratio, first, second }
}
function collectGroupIds(node: EditorLayoutNode | null): string[] {
  if (!node) return []
  if (node.type === 'group') return [node.groupId]
  return [...collectGroupIds(node.first), ...collectGroupIds(node.second)]
}
function setWorkbenchState({
  openEditors,
  activeEditorId,
  editorGroups,
  editorLayout,
  activeEditorGroupId,
}: {
  openEditors: any[]
  activeEditorId: string | null
  editorGroups: EditorGroupState[]
  editorLayout: EditorLayoutNode | null
  activeEditorGroupId: string | null
}) {
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
async function dispatchDragEvent(
  target: Element,
  type: 'dragover' | 'drop',
  dataTransfer: any,
  coords?: { clientX: number; clientY: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: coords?.clientX ?? 0 })
  Object.defineProperty(event, 'clientY', { value: coords?.clientY ?? 0 })
  await act(async () => {
    target.dispatchEvent(event)
  })
}

describe('EditorWorkbench', () => {
  const editor1 = createEditor('editor-1', 'src/index.ts', 'const value=1', {
    modifiedAt: '2026-05-29T00:00:00.000Z',
    size: 13,
  })
  const editor2 = createEditor('editor-2', 'src/other.ts', 'const value=2')
  const editor3 = createEditor('editor-3', 'src/third.ts', 'const value=3')
  const editor4 = createEditor('editor-4', 'src/fourth.ts', 'const value=4')
  beforeEach(() => {
    vi.useFakeTimers()
    resolveDefinitionMock.mockReset()
    openFileInEditorMock.mockReset()
    openFileInEditorMock.mockImplementation(async (file: any) => {
      useConsoleStore.getState().setActiveEditor(file.id)
      return file.id
    })
    monacoMouseDownRef.current = null
    monacoCursorHandlerRef.current = null
    liveEditors.clear()
    editorInstanceMocks.setPosition.mockReset()
    editorInstanceMocks.setSelection.mockReset()
    editorInstanceMocks.revealLineInCenter.mockReset()
    editorInstanceMocks.focus.mockReset()
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
    return render(
      React.createElement(EditorWorkbench, {
        onSaveEditor: vi.fn(async () => {}),
        onOpenFile: vi.fn(async (file) => file.id),
        onOpenFileAtPosition: vi.fn(async (file) => file.id),
        onCreateCompare: vi.fn(async () => {}),
        ...overrides,
      }),
    )
  }
  function createOpenFileHandler() {
    return vi.fn(async (file) => {
      useConsoleStore.getState().openEditor({ ...file, language: 'typescript' })
      useConsoleStore.getState().setEditorLoaded(file.id, {
        content: '',
        savedContent: '',
        modifiedAt: '',
        size: 0,
        dirty: false,
        loading: false,
        saving: false,
        binary: false,
        truncated: false,
      })
      return file.id
    })
  }

  // 导航验收基线：A/B 同组，opener 派发真实 location 事件，resolver 可控
  function setupNavigationReview() {
    const content = Array.from({ length: 100 }, (_, index) => `// line ${index + 1} -------------------`).join('\n')
    const source = { ...editor1, content }
    const target = { ...editor2, content }
    setWorkbenchState({
      openEditors: [source, target],
      activeEditorId: source.id,
      editorGroups: [createGroup('group-1', [source.id, target.id], source.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    openFileInEditorMock.mockImplementation(async (file: any, options: any) => {
      useConsoleStore.getState().setActiveEditor(file.id)
      window.dispatchEvent(
        new CustomEvent('tmuxgo-open-editor-location', {
          detail: { editorId: file.id, ...options?.position, restore: options?.restore },
        }),
      )
      return file.id
    })
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...target, type: 'file', line: 60, column: 10 },
    })
    const view = renderWorkbench()
    return { source, target, view }
  }
  const advanceNavigation = async (ms = 20) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('shows in-place retry after save failure while keeping dirty content', () => {
    const onSaveEditor = vi.fn(async () => {})
    useConsoleStore.setState({
      openEditors: [{ ...editor1, content: 'const value=2', dirty: true, saveError: 'network down' }],
    } as any)
    renderWorkbench({ onSaveEditor })
    expect(screen.getByText(/Save failed; changes are kept/)).toBeTruthy()
    expect(screen.getByText(/network down/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onSaveEditor).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText(/Save failed; changes are kept/)).toBeNull()
    expect(useConsoleStore.getState().openEditors[0]?.saveError).toBeUndefined()
    expect(useConsoleStore.getState().openEditors[0]?.dirty).toBe(true)
  })
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
    const body = container.querySelector(
      'section[data-editor-drop] > .relative.min-h-0.flex-1.bg-bg-0 > .flex.h-full.min-h-0.flex-col',
    ) as HTMLDivElement | null
    const pane = body?.firstElementChild as HTMLDivElement | null
    const surface = pane?.querySelector(
      'button.relative.min-h-0.min-w-0.flex-1.overflow-hidden.text-left',
    ) as HTMLButtonElement | null
    expect(body).toBeTruthy()
    expect(pane).toBeTruthy()
    expect(surface).toBeTruthy()
    expect(body?.className).toContain('h-full')
    expect(pane?.className).toContain('flex-1')
    expect(surface?.className).toContain('flex-1')
  })
  it('renders markdown preview immediately and can hide it', () => {
    const editor = createEditor('editor-md', 'README.md', '# Markdown preview', { language: 'markdown' })
    setWorkbenchState({
      openEditors: [editor],
      activeEditorId: editor.id,
      editorGroups: [createGroup('group-1', [editor.id], editor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    expect(screen.getByRole('heading', { name: 'Markdown preview' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('heading', { name: 'Markdown preview' })).not.toBeInTheDocument()
  })
  it('renders html preview immediately in a sandboxed frame', () => {
    const content = '<!doctype html><html><body><h1>HTML preview</h1></body></html>'
    const editor = createEditor('editor-html', 'page.html', content, { language: 'html' })
    setWorkbenchState({
      openEditors: [editor],
      activeEditorId: editor.id,
      editorGroups: [createGroup('group-1', [editor.id], editor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const frame = screen.getByTitle('page.html')
    expect(frame).toHaveAttribute('srcdoc', content)
    expect(frame).toHaveAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-scripts')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByTitle('page.html')).not.toBeInTheDocument()
  })
  it('renders csv preview as a table and can hide it', () => {
    const editor = createEditor('editor-csv', 'data.csv', 'name,age\nalice,30\nbob,25', { language: 'csv' })
    setWorkbenchState({
      openEditors: [editor],
      activeEditorId: editor.id,
      editorGroups: [createGroup('group-1', [editor.id], editor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'alice' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
  })
  it('clears all opened editors from the toolbar button', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
        createGroup('group-3', [editor3.id], editor3.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3')),
      ),
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
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench()
    const strips = [
      screen.getByTestId('editor-group-primary') as HTMLDivElement,
      screen.getByTestId('editor-group-secondary') as HTMLDivElement,
    ]
    for (const strip of strips) {
      expect(strip.className).toContain('min-h-6')
    }
    const tabs = ['index.ts', 'other.ts'].map(
      (name) => screen.getByRole('button', { name }).parentElement as HTMLDivElement,
    )
    for (const tab of tabs) {
      expect(tab.className).toContain('h-6')
    }
  })
  it('moves a dragged tab into the primary group and collapses the source split', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
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
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 100,
          height: 42,
          right: 100,
          bottom: 42,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 100,
          height: 42,
          right: 100,
          bottom: 42,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    await dispatchDragEvent(button, 'drop', dataTransfer, { clientX: 0, clientY: 0 })
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'drop-tab.ts' })),
    )
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
    ;(button as HTMLButtonElement).getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 100,
          height: 42,
          right: 100,
          bottom: 42,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
        createGroup('group-3', [editor3.id], editor3.id),
        createGroup('group-4', [editor4.id], editor4.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createSplit(
          'layout-3',
          'vertical',
          createLeaf('layout-4', 'group-2'),
          createSplit('layout-5', 'horizontal', createLeaf('layout-6', 'group-3'), createLeaf('layout-7', 'group-4')),
        ),
      ),
      activeEditorGroupId: 'group-4',
    })
    const { container } = renderWorkbench()
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    strip.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 42,
          right: 1000,
          bottom: 42,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
    ;(dropZone as HTMLDivElement).getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 600,
          right: 1000,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    await dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 500, clientY: 300 })
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'drop.ts' })),
    )
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
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-12', name: 'surface.ts' })),
    )
    expect(useConsoleStore.getState().openEditors.find((item) => item.id === editor1.id)?.content).toBe('const value=1')
    expect(useConsoleStore.getState().openEditors.find((item) => item.id === editor1.id)?.dirty).toBe(false)
  })
  it('opens a dragged file when dropped on the secondary tab strip', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    strip.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 42,
          right: 1000,
          bottom: 42,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'strip.ts' })),
    )
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([editor2.id, 'editor-4'])
  })
  it('splits the active group when dropped on the left edge of the editor area', async () => {
    const onOpenFile = createOpenFileHandler()
    const view = renderWorkbench({ onOpenFile })
    const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as HTMLDivElement
    dropZone.getBoundingClientRect = vi.fn(() => createRect())
    const dataTransfer = createFileDataTransfer('editor-4', 'src/left.ts')
    await dispatchDragEvent(dropZone, 'drop', dataTransfer, { clientX: 40, clientY: 300 })
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-4', name: 'left.ts' })),
    )
    expect(useConsoleStore.getState().editorSplitDirection).toBe('horizontal')
    expect(useConsoleStore.getState().editorPrimaryGroupIds).toEqual(['editor-4'])
    expect(useConsoleStore.getState().editorSecondaryGroupIds).toEqual([editor1.id])
  })
  it.each([
    {
      title: 'right edge',
      id: 'editor-7',
      path: 'src/right.ts',
      clientX: 960,
      clientY: 300,
      direction: 'horizontal',
      first: 'group-1',
      second: 'new',
    },
    {
      title: 'top edge',
      id: 'editor-8',
      path: 'src/top-root.ts',
      clientX: 500,
      clientY: 40,
      direction: 'vertical',
      first: 'new',
      second: 'group-1',
    },
    {
      title: 'bottom edge',
      id: 'editor-9',
      path: 'src/bottom-root.ts',
      clientX: 500,
      clientY: 560,
      direction: 'vertical',
      first: 'group-1',
      second: 'new',
    },
  ])(
    'splits the active group from the $title of the editor area',
    async ({ id, path, clientX, clientY, direction, first, second }) => {
      const onOpenFile = createOpenFileHandler()
      const view = renderWorkbench({ onOpenFile })
      const dropZone = view.container.querySelector('section > .relative.min-h-0.flex-1.bg-bg-0') as HTMLDivElement
      dropZone.getBoundingClientRect = vi.fn(() => createRect())
      await dispatchDragEvent(dropZone, 'drop', createFileDataTransfer(id, path), { clientX, clientY })
      await vi.waitFor(() =>
        expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id, name: path.split('/').pop() })),
      )
      const state = useConsoleStore.getState()
      const newGroupId = state.editorGroups.find((group) => group.editorIds.includes(id))?.id
      expect(newGroupId).toBeTruthy()
      expect(state.editorLayout?.type).toBe('split')
      expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe(direction)
      expect(
        state.editorLayout?.type === 'split' && state.editorLayout.first.type === 'group'
          ? state.editorLayout.first.groupId
          : null,
      ).toBe(first === 'new' ? newGroupId : first)
      expect(
        state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'group'
          ? state.editorLayout.second.groupId
          : null,
      ).toBe(second === 'new' ? newGroupId : second)
      expect(screen.getAllByLabelText('editor')).toHaveLength(2)
    },
  )
  it('splits the secondary group vertically when dropped on its top edge', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
      activeEditorGroupId: 'group-2',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 600,
          right: 1000,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-5', name: 'top.ts' })),
    )
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-5'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe('horizontal')
    expect(
      state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split'
        ? state.editorLayout.second.direction
        : null,
    ).toBe('vertical')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.first.type === 'group'
        ? state.editorLayout.second.first.groupId
        : null,
    ).toBe(newGroupId)
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.second.type === 'group'
        ? state.editorLayout.second.second.groupId
        : null,
    ).toBe('group-2')
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
    const splits = Array.from(container.querySelectorAll('[data-editor-split]')) as HTMLDivElement[]
    expect(splits).toHaveLength(2)
  })
  it('splits the secondary group vertically when dropped on its bottom edge', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
      activeEditorGroupId: 'group-2',
    })
    renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 1000,
          height: 600,
          right: 1000,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
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
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-6', name: 'bottom.ts' })),
    )
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-6'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.direction : null).toBe('horizontal')
    expect(
      state.editorLayout?.type === 'split' && state.editorLayout.second.type === 'split'
        ? state.editorLayout.second.direction
        : null,
    ).toBe('vertical')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.first.type === 'group'
        ? state.editorLayout.second.first.groupId
        : null,
    ).toBe('group-2')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.second.type === 'group'
        ? state.editorLayout.second.second.groupId
        : null,
    ).toBe(newGroupId)
    expect(screen.getAllByLabelText('editor')).toHaveLength(3)
  })
  it('splits the middle group vertically in a nested 3-group layout and reaches 4 groups', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
        createGroup('group-3', [editor3.id], editor3.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3')),
      ),
      activeEditorGroupId: 'group-3',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-secondary') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => createRect())
    await dispatchDragEvent(pane, 'drop', createFileDataTransfer('editor-10', 'src/nested-top.ts'), {
      clientX: 500,
      clientY: 40,
    })
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-10', name: 'nested-top.ts' })),
    )
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-10'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorGroups).toHaveLength(4)
    expect(collectGroupIds(state.editorLayout)).toEqual(['group-1', newGroupId as string, 'group-2', 'group-3'])
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.first.type === 'split'
        ? state.editorLayout.second.first.direction
        : null,
    ).toBe('vertical')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.first.type === 'split' &&
        state.editorLayout.second.first.first.type === 'group'
        ? state.editorLayout.second.first.first.groupId
        : null,
    ).toBe(newGroupId)
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.first.type === 'split' &&
        state.editorLayout.second.first.second.type === 'group'
        ? state.editorLayout.second.first.second.groupId
        : null,
    ).toBe('group-2')
    expect(screen.getAllByLabelText('editor')).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('[data-editor-split]'))).toHaveLength(3)
  })
  it('splits the last group horizontally in a nested 3-group layout and reaches 4 groups', async () => {
    const onOpenFile = createOpenFileHandler()
    setWorkbenchState({
      openEditors: [editor1, editor2, editor3],
      activeEditorId: editor3.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
        createGroup('group-3', [editor3.id], editor3.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3')),
      ),
      activeEditorGroupId: 'group-3',
    })
    const { container } = renderWorkbench({ onOpenFile })
    const strip = screen.getByTestId('editor-group-group-3') as HTMLDivElement
    const pane = strip.nextElementSibling as HTMLButtonElement
    pane.getBoundingClientRect = vi.fn(() => createRect())
    await dispatchDragEvent(pane, 'drop', createFileDataTransfer('editor-11', 'src/nested-right.ts'), {
      clientX: 960,
      clientY: 300,
    })
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'editor-11', name: 'nested-right.ts' })),
    )
    const state = useConsoleStore.getState()
    const newGroupId = state.editorGroups.find((group) => group.editorIds.includes('editor-11'))?.id
    expect(newGroupId).toBeTruthy()
    expect(state.editorGroups).toHaveLength(4)
    expect(collectGroupIds(state.editorLayout)).toEqual(['group-1', 'group-2', 'group-3', newGroupId as string])
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.second.type === 'split'
        ? state.editorLayout.second.second.direction
        : null,
    ).toBe('horizontal')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.second.type === 'split' &&
        state.editorLayout.second.second.first.type === 'group'
        ? state.editorLayout.second.second.first.groupId
        : null,
    ).toBe('group-3')
    expect(
      state.editorLayout?.type === 'split' &&
        state.editorLayout.second.type === 'split' &&
        state.editorLayout.second.second.type === 'split' &&
        state.editorLayout.second.second.second.type === 'group'
        ? state.editorLayout.second.second.second.groupId
        : null,
    ).toBe(newGroupId)
    expect(screen.getAllByLabelText('editor')).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('[data-editor-split]'))).toHaveLength(3)
  })
  it('renders split panes from store state', () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor2.id,
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createLeaf('layout-3', 'group-2'),
      ),
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
      editorGroups: [
        createGroup('group-1', [editor1.id], editor1.id),
        createGroup('group-2', [editor2.id], editor2.id),
        createGroup('group-3', [editor3.id], editor3.id),
      ],
      editorLayout: createSplit(
        'layout-1',
        'horizontal',
        createLeaf('layout-2', 'group-1'),
        createSplit('layout-3', 'vertical', createLeaf('layout-4', 'group-2'), createLeaf('layout-5', 'group-3')),
      ),
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
    expect(diffPropsRef.current.at(-1)).toMatchObject({
      original: 'const value=1',
      modified: 'const value=2',
      language: 'typescript',
    })
  })
  it('jumps to a definition with F12 and navigates back', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor1.id,
      editorGroups: [createGroup('group-1', [editor1.id, editor2.id], editor1.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...editor2, type: 'file', line: 1, column: 7 },
    })
    renderWorkbench()
    fireEvent.keyDown(window, { key: 'F12' })
    await vi.waitFor(() =>
      expect(openFileInEditorMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: editor2.id, type: 'file' }),
        expect.objectContaining({ position: { line: 1, column: 7 }, skipReload: true }),
      ),
    )
    expect(useConsoleStore.getState().activeEditorId).toBe(editor2.id)
    const backButton = screen.getByRole('button', { name: 'Back' })
    expect(backButton).not.toBeDisabled()
    fireEvent.click(backButton)
    await vi.waitFor(() => expect(useConsoleStore.getState().activeEditorId).toBe(editor1.id))
    expect(screen.getByRole('button', { name: 'Forward' })).not.toBeDisabled()
  })
  it('jumps to a definition from a Monaco ctrl-click', async () => {
    setWorkbenchState({
      openEditors: [editor1, editor2],
      activeEditorId: editor1.id,
      editorGroups: [createGroup('group-1', [editor1.id, editor2.id], editor1.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...editor2, type: 'file', line: 2, column: 3 },
    })
    renderWorkbench()
    expect(monacoMouseDownRef.current).toBeTruthy()
    monacoMouseDownRef.current?.({
      event: {
        browserEvent: { button: 0, ctrlKey: true, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      },
      target: { position: { lineNumber: 2, column: 4 } },
    })
    await vi.waitFor(() =>
      expect(resolveDefinitionMock).toHaveBeenCalledWith(
        editor1,
        { line: 2, column: 4 },
        expect.any(Array),
        expect.any(AbortSignal),
      ),
    )
    expect(openFileInEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: editor2.id }),
      expect.objectContaining({ position: { line: 2, column: 3 }, skipReload: true }),
    )
  })
  it('jumps to the source line when double-clicking a markdown preview block', async () => {
    const mdEditor = {
      ...editor1,
      id: 'local:root-workspace:docs/readme.md',
      name: 'readme.md',
      path: 'docs/readme.md',
      absolutePath: '/workspace/docs/readme.md',
      language: 'markdown',
      content: '# 标题\n\n正文段落',
    }
    setWorkbenchState({
      openEditors: [mdEditor],
      activeEditorId: mdEditor.id,
      editorGroups: [createGroup('group-1', [mdEditor.id], mdEditor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const heading = document.querySelector('article h1')
    if (!heading) throw new Error('markdown preview not rendered')
    fireEvent.doubleClick(heading)
    expect(editorInstanceMocks.revealLineInCenter).toHaveBeenCalledWith(1)
    expect(editorInstanceMocks.setPosition).toHaveBeenCalledWith({ lineNumber: 1, column: 1 })
    expect(editorInstanceMocks.focus).toHaveBeenCalled()
  })
  it('highlights the markdown preview block matching the editor cursor', async () => {
    const mdEditor = {
      ...editor1,
      id: 'local:root-workspace:docs/readme.md',
      name: 'readme.md',
      path: 'docs/readme.md',
      absolutePath: '/workspace/docs/readme.md',
      language: 'markdown',
      content: '# 标题\n\n正文段落',
    }
    setWorkbenchState({
      openEditors: [mdEditor],
      activeEditorId: mdEditor.id,
      editorGroups: [createGroup('group-1', [mdEditor.id], mdEditor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const paragraph = document.querySelector('article p')
    if (!paragraph) throw new Error('markdown preview not rendered')
    await act(async () => {
      monacoCursorHandlerRef.current?.({ position: { lineNumber: 3, column: 1 } })
    })
    expect(paragraph.classList.contains('md-source-loc')).toBe(true)
    await act(async () => {
      monacoCursorHandlerRef.current?.({ position: { lineNumber: 1, column: 1 } })
    })
    expect(paragraph.classList.contains('md-source-loc')).toBe(false)
    expect(document.querySelector('article h1')?.classList.contains('md-source-loc')).toBe(true)
  })
  it('renders markdown preview with GFM tables, images, lists and strikethrough', () => {
    const mdEditor = {
      ...editor1,
      id: 'local:root-workspace:docs/readme.md',
      name: 'readme.md',
      path: 'docs/readme.md',
      absolutePath: '/workspace/docs/readme.md',
      language: 'markdown',
      content:
        '# 标题\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n- 项目一\n1. 有序\n\n~~删除~~ ![图](https://example.com/a.png)\n\n```ts\nconst a = 1\n```',
    }
    setWorkbenchState({
      openEditors: [mdEditor],
      activeEditorId: mdEditor.id,
      editorGroups: [createGroup('group-1', [mdEditor.id], mdEditor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const article = document.querySelector('article')
    if (!article) throw new Error('markdown preview not rendered')
    const html = article.innerHTML
    expect(article.querySelector('h1')).toHaveAttribute('data-line', '1')
    expect(article.querySelector('h1')).toHaveTextContent('标题')
    expect(html).toContain('<table data-line="3">')
    expect(html).toContain('<th>列A</th>')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('<li data-line="7">项目一</li>')
    expect(html).toContain('<ol data-line="8">')
    expect(html).toContain('<img src="https://example.com/a.png"')
    expect(html).toContain('<del>删除</del>')
    expect(html).toContain('<pre data-line="12"><code class="language-ts">')
  })
  it('renders consecutive blank lines as visible gaps and keeps code block blank lines', () => {
    const mdEditor = {
      ...editor1,
      id: 'local:root-workspace:docs/blank.md',
      name: 'blank.md',
      path: 'docs/blank.md',
      absolutePath: '/workspace/docs/blank.md',
      language: 'markdown',
      content: '前\n\n\n中\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n\n后',
    }
    setWorkbenchState({
      openEditors: [mdEditor],
      activeEditorId: mdEditor.id,
      editorGroups: [createGroup('group-1', [mdEditor.id], mdEditor.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    const article = document.querySelector('article')
    if (!article) throw new Error('markdown preview not rendered')
    const html = article.innerHTML
    expect(article.querySelector('[data-line="1"]')).toHaveTextContent('前')
    expect(html).toContain('<p data-line="4">中</p>')
    expect(html).toContain('<pre data-line="6"><code class="language-ts">const a = 1\n\n\nconst b = 2')
    expect(html).toContain('<br><p data-line="14">后</p>')
  })

  it.each([
    {
      name: 'Alt+Left',
      trigger: () => fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true }),
    },
    {
      name: 'the Back button',
      trigger: () => fireEvent.click(screen.getByRole('button', { name: 'Back' })),
    },
  ])('a stale definition result does not navigate or pollute history after $name', async ({ trigger }) => {
    const { source, target } = setupNavigationReview()
    act(() => liveEditors.get(source.absolutePath).setPosition({ lineNumber: 22, column: 4 }))
    fireEvent.keyDown(window, { key: 'F12' })
    await advanceNavigation()
    expect(liveEditors.get(target.absolutePath).getPosition()).toEqual({ lineNumber: 60, column: 10 })
    let finish: any
    resolveDefinitionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.keyDown(window, { key: 'F12' })
    trigger()
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(source.id)
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 22, column: 4 })
    await act(async () => {
      finish({ status: 'success', target: { ...target, type: 'file', line: 90, column: 10 } })
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(useConsoleStore.getState().activeEditorId).toBe(source.id)
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 22, column: 4 })
    // 历史栈未被旧结果污染：Forward 仍回到离开 B 时的 60:10
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(target.id)
    expect(liveEditors.get(target.absolutePath).getPosition()).toEqual({ lineNumber: 60, column: 10 })
  })
  it('a stale definition result does not steal focus after a manual tab switch', async () => {
    const { target } = setupNavigationReview()
    let finish: any
    resolveDefinitionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.keyDown(window, { key: 'F12' })
    fireEvent.click(screen.getByRole('button', { name: 'other.ts' }))
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(target.id)
    await act(async () => {
      finish({ status: 'success', target: { ...editor3, type: 'file', line: 90, column: 10 } })
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(useConsoleStore.getState().activeEditorId).toBe(target.id)
    expect(openFileInEditorMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: editor3.id }),
      expect.anything(),
    )
  })
  it('a stale definition result does not reopen a closed source file', async () => {
    const { target } = setupNavigationReview()
    let finish: any
    resolveDefinitionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.keyDown(window, { key: 'F12' })
    act(() => useConsoleStore.getState().closeEditor('editor-1'))
    await act(async () => {
      finish({ status: 'success', target: { ...target, type: 'file', line: 90, column: 10 } })
      await vi.advanceTimersByTimeAsync(20)
    })
    // 旧结果不得发起导航：target 被 store 正常激活而非旧结果跳转，落位也不会到 90:10
    expect(openFileInEditorMock).not.toHaveBeenCalledWith(expect.objectContaining({ id: target.id }), expect.anything())
    expect(liveEditors.get(target.absolutePath).getPosition()).toEqual({ lineNumber: 1, column: 1 })
  })
  it('a stale definition result does not navigate after the workbench unmounts', async () => {
    const { target, view } = setupNavigationReview()
    let finish: any
    resolveDefinitionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.keyDown(window, { key: 'F12' })
    view.unmount()
    await act(async () => {
      finish({ status: 'success', target: { ...target, type: 'file', line: 90, column: 10 } })
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(openFileInEditorMock).not.toHaveBeenCalledWith(expect.objectContaining({ id: target.id }), expect.anything())
  })
  it('keeps the back entry when the target file fails to open', async () => {
    const { source, target } = setupNavigationReview()
    act(() => liveEditors.get(source.absolutePath).setPosition({ lineNumber: 22, column: 4 }))
    fireEvent.keyDown(window, { key: 'F12' })
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(target.id)
    openFileInEditorMock.mockImplementationOnce(async (file: any, options: any) => {
      useConsoleStore.getState().setActiveEditor(file.id)
      options?.onError?.('read failed')
      return file.id
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await advanceNavigation()
    // 打开失败：back 栈回滚可重试，forward 不残留
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(source.id)
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 22, column: 4 })
  })
  it('a stale pending location does not override the user cursor after a quick remount', async () => {
    const { source, target } = setupNavigationReview()
    act(() =>
      window.dispatchEvent(
        new CustomEvent('tmuxgo-open-editor-location', { detail: { editorId: source.id, line: 33, column: 3 } }),
      ),
    )
    await advanceNavigation()
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 33, column: 3 })
    act(() => liveEditors.get(source.absolutePath).setPosition({ lineNumber: 44, column: 5 }))
    act(() => useConsoleStore.getState().setActiveEditor(target.id))
    act(() => useConsoleStore.getState().setActiveEditor(source.id))
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 44, column: 5 })
  })
  it('re-applies the landed position when a remount belongs to the same navigation', async () => {
    const { source, target } = setupNavigationReview()
    act(() =>
      window.dispatchEvent(
        new CustomEvent('tmuxgo-open-editor-location', { detail: { editorId: source.id, line: 33, column: 3 } }),
      ),
    )
    await advanceNavigation()
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 33, column: 3 })
    act(() => useConsoleStore.getState().setActiveEditor(target.id))
    act(() => useConsoleStore.getState().setActiveEditor(source.id))
    expect(liveEditors.get(source.absolutePath).getPosition()).toEqual({ lineNumber: 33, column: 3 })
  })
  it('applies a pending location once the target finishes loading', async () => {
    const content = Array.from({ length: 100 }, (_, index) => `// line ${index + 1}`).join('\n')
    const loadingEditor = createEditor('editor-loading', 'src/loading.ts', '', { loading: true })
    setWorkbenchState({
      openEditors: [editor1, loadingEditor],
      activeEditorId: editor1.id,
      editorGroups: [createGroup('group-1', [editor1.id, loadingEditor.id], editor1.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    act(() =>
      window.dispatchEvent(
        new CustomEvent('tmuxgo-open-editor-location', { detail: { editorId: loadingEditor.id, line: 77, column: 2 } }),
      ),
    )
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(loadingEditor.id)
    expect(liveEditors.has(loadingEditor.absolutePath)).toBe(false)
    act(() => useConsoleStore.getState().setEditorLoaded(loadingEditor.id, { loading: false, content }))
    await advanceNavigation()
    expect(liveEditors.get(loadingEditor.absolutePath).getPosition()).toEqual({ lineNumber: 77, column: 2 })
  })
  it('clamps a pending location column to the model line range', async () => {
    renderWorkbench()
    act(() =>
      window.dispatchEvent(
        new CustomEvent('tmuxgo-open-editor-location', { detail: { editorId: editor1.id, line: 1, column: 99 } }),
      ),
    )
    await advanceNavigation()
    // 'const value=1' 行宽 13，列钳到 maxColumn 14
    expect(liveEditors.get(editor1.absolutePath).getPosition()).toEqual({ lineNumber: 1, column: 14 })
  })
  it('restores selection and scroll on Back without forcing the line to center', async () => {
    const { source, target } = setupNavigationReview()
    const sourceInstance = liveEditors.get(source.absolutePath)
    act(() => {
      sourceInstance.setPosition({ lineNumber: 22, column: 4 })
      sourceInstance.setSelection({
        startLineNumber: 22,
        startColumn: 4,
        endLineNumber: 25,
        endColumn: 2,
      })
      sourceInstance.setScrollTop(200)
      sourceInstance.setScrollLeft(30)
    })
    fireEvent.keyDown(window, { key: 'F12' })
    await advanceNavigation()
    const targetInstance = liveEditors.get(target.absolutePath)
    expect(targetInstance.getPosition()).toEqual({ lineNumber: 60, column: 10 })
    expect(targetInstance.revealPositionInCenter).toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    await advanceNavigation()
    expect(useConsoleStore.getState().activeEditorId).toBe(source.id)
    const remounted = liveEditors.get(source.absolutePath)
    expect(remounted).not.toBe(sourceInstance)
    expect(remounted.getPosition()).toEqual({ lineNumber: 25, column: 2 })
    expect(remounted.getSelection()).toEqual({
      startLineNumber: 22,
      startColumn: 4,
      endLineNumber: 25,
      endColumn: 2,
    })
    expect(remounted.getScrollTop()).toBe(200)
    expect(remounted.getScrollLeft()).toBe(30)
    expect(remounted.revealPositionInCenter).not.toHaveBeenCalled()
  })
  it('restores the exact scroll position after switching away and back', async () => {
    const content = Array.from({ length: 200 }, (_, index) => `const l${index} = ${index}`).join('\n')
    const a = { ...editor1, content }
    const b = { ...editor2, content }
    setWorkbenchState({
      openEditors: [a, b],
      activeEditorId: a.id,
      editorGroups: [createGroup('group-1', [a.id, b.id], a.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    act(() => {
      const instance = liveEditors.get(a.absolutePath)
      instance.setScrollTop(1600)
      instance.setScrollLeft(80)
      instance.setPosition({ lineNumber: 50, column: 3 })
    })
    act(() => useConsoleStore.getState().setActiveEditor(b.id))
    act(() => useConsoleStore.getState().setActiveEditor(a.id))
    await advanceNavigation()
    const remounted = liveEditors.get(a.absolutePath)
    expect(remounted.getScrollTop()).toBe(1600)
    expect(remounted.getScrollLeft()).toBe(80)
    expect(remounted.getPosition()).toEqual({ lineNumber: 50, column: 3 })
  })
  // 10 组随机翻动+随机切换：每个 tab 的滚动/光标各自独立还原，不得回到顶部
  it('keeps per-tab scroll and cursor across 10 randomized tab switches', async () => {
    const content = (tag: string) => Array.from({ length: 300 }, (_, index) => `// ${tag} line ${index + 1}`).join('\n')
    const files = [
      { ...editor1, content: content('a') },
      { ...editor2, content: content('b') },
      { ...editor3, content: content('c') },
    ]
    setWorkbenchState({
      openEditors: files,
      activeEditorId: files[0].id,
      editorGroups: [
        createGroup(
          'group-1',
          files.map((file) => file.id),
          files[0].id,
        ),
      ],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    let seed = 20260924
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor((seed / 2147483648) * max)
    }
    for (let round = 0; round < 10; round++) {
      const from = files[round % files.length]
      // rand(len-1)∈[0,len-2]：目标索引在 (i+1..i+len-1)%len 内，必与 from 不同
      const to = files[(round + 1 + rand(files.length - 1)) % files.length]
      const scrollTop = 1 + rand(200)
      const scrollLeft = rand(120)
      const position = { lineNumber: 1 + rand(300), column: 1 + rand(10) }
      act(() => useConsoleStore.getState().setActiveEditor(from.id))
      act(() => {
        const instance = liveEditors.get(from.absolutePath)
        instance.setScrollTop(scrollTop)
        instance.setScrollLeft(scrollLeft)
        instance.setPosition(position)
      })
      act(() => useConsoleStore.getState().setActiveEditor(to.id))
      act(() => useConsoleStore.getState().setActiveEditor(from.id))
      await advanceNavigation()
      const remounted = liveEditors.get(from.absolutePath)
      expect(remounted.getScrollTop(), `round ${round} scrollTop`).toBe(scrollTop)
      expect(remounted.getScrollLeft(), `round ${round} scrollLeft`).toBe(scrollLeft)
      expect(remounted.getPosition(), `round ${round} position`).toEqual(position)
    }
  })
  it('clears the stored view state once the file is closed and reopened', async () => {
    const content = Array.from({ length: 200 }, (_, index) => `// line ${index + 1}`).join('\n')
    const a = { ...editor1, content }
    const b = { ...editor2, content }
    setWorkbenchState({
      openEditors: [a, b],
      activeEditorId: a.id,
      editorGroups: [createGroup('group-1', [a.id, b.id], a.id)],
      editorLayout: createLeaf('layout-1', 'group-1'),
      activeEditorGroupId: 'group-1',
    })
    renderWorkbench()
    act(() => {
      liveEditors.get(a.absolutePath).setScrollTop(900)
      liveEditors.get(a.absolutePath).setPosition({ lineNumber: 50, column: 3 })
    })
    act(() => useConsoleStore.getState().closeEditor(a.id))
    await advanceNavigation()
    // 重开同一文件：定位数据已随关闭清空，回到顶部 1:1 而不是旧位置
    act(() => {
      useConsoleStore.getState().openEditor({
        id: a.id,
        hostId: a.hostId,
        rootId: a.rootId,
        rootLabel: a.rootLabel,
        rootPath: a.rootPath,
        path: a.path,
        name: a.name,
        absolutePath: a.absolutePath,
        type: 'file',
        language: 'typescript',
      } as any)
      useConsoleStore.getState().setEditorLoaded(a.id, {
        loading: false,
        content,
        savedContent: content,
        modifiedAt: '',
        size: content.length,
        dirty: false,
        saving: false,
        binary: false,
        truncated: false,
      })
    })
    await advanceNavigation()
    const reopened = liveEditors.get(a.absolutePath)
    expect(reopened.getScrollTop()).toBe(0)
    expect(reopened.getScrollLeft()).toBe(0)
    expect(reopened.getPosition()).toEqual({ lineNumber: 1, column: 1 })
  })
})
