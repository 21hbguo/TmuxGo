import { act, cleanup, render } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from '@/components/EditorWorkbench'
import { OPEN_EDITOR_LOCATION_EVENT } from '@/lib/editor-open'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { EditorGroupState, EditorLayoutNode } from '@/stores/useConsoleStore'

const resolveDefinitionMock = vi.hoisted(() => vi.fn())
const contentMock = vi.hoisted(() => vi.fn())
// 每个 editor.id 一个实例记录：捕获 onMount 时机的 setPosition/reveal 调用
const instances = vi.hoisted(() => ({ byEditor: {} as Record<string, any[]> }))
const mountedEditorIdRef = vi.hoisted(() => ({ current: null as string | null }))

vi.mock('@/lib/code-navigation', () => ({
  resolveEditorDefinition: (...args: any[]) => resolveDefinitionMock(...args),
}))
vi.mock('@/lib/api', () => ({
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
      searchContent: vi.fn(async () => []),
      preview: vi.fn(async () => ({ modifiedAt: '' })),
      imageUrl: vi.fn(() => ''),
    },
  },
  fetchApiBlob: vi.fn(async () => new Blob()),
}))
vi.mock('@/lib/dynamic', () => ({
  default: (loader: any) =>
    loader.toString().includes('mod.DiffEditor')
      ? () => React.createElement('div', { 'data-testid': 'diff-editor' })
      : ({ value, path, onChange: _onChange, onMount }: any) => {
          const mountedRef = React.useRef(false)
          React.useEffect(() => {
            if (mountedRef.current) return
            mountedRef.current = true
            const pos = { lineNumber: 1, column: 1 }
            const instance = {
              setPosition: vi.fn((p: any) => {
                pos.lineNumber = p.lineNumber
                pos.column = p.column
              }),
              revealPositionInCenter: vi.fn(),
              focus: vi.fn(),
              getPosition: vi.fn(() => ({ ...pos })),
              getModel: vi.fn(() => ({ getLineCount: () => 500 })),
              getAction: vi.fn(() => ({ run: vi.fn() })),
              onDidChangeCursorPosition: vi.fn(() => ({ dispose: vi.fn() })),
              onMouseDown: vi.fn(() => ({ dispose: vi.fn() })),
              onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
            }
            instances.byEditor[path] = [...(instances.byEditor[path] || []), instance]
            onMount?.(instance)
          }, [onMount, path])
          return React.createElement('textarea', { 'aria-label': 'editor', value, onChange: () => {} })
        },
}))
vi.mock('@monaco-editor/react', () => ({ default: () => null, DiffEditor: () => null }))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { theme: 'dark', fontFamily: 'monospace', fontSize: 14 } }),
}))
vi.mock('@/hooks/useApi', () => ({ useGitDetect: () => ({ data: { isGitRepo: false } }) }))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string, opts?: any) => (opts?.name ? `${key}:${opts.name}` : key) }),
}))

function createEditor(id: string, path: string, content: string, overrides: Record<string, any> = {}) {
  return {
    id,
    hostId: 'local',
    rootId: 'root-ws',
    rootLabel: 'WS',
    rootPath: '/ws',
    path,
    name: path.split('/').pop() || path,
    absolutePath: `/ws/${path}`,
    language: 'python',
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
    type: 'file',
    ...overrides,
  }
}
function createGroup(id: string, editorIds: string[], activeEditorId: string | null): EditorGroupState {
  return { id, editorIds, activeEditorId }
}
const leaf = (groupId: string): EditorLayoutNode => ({ id: `layout-${groupId}`, type: 'group', groupId })

function setState(
  openEditors: any[],
  groups: EditorGroupState[],
  activeEditorId: string | null,
  activeGroupId: string,
) {
  const group = groups.find((g) => g.id === activeGroupId)!
  useConsoleStore.setState({
    openEditors,
    activeEditorId,
    editorGroups: groups,
    editorLayout: leaf(groups[0].id),
    activeEditorGroupId: activeGroupId,
    editorPrimaryGroupIds: group.editorIds,
    editorPrimaryId: group.activeEditorId,
    editorSecondaryGroupIds: [],
    editorSecondaryId: null,
    editorSplitDirection: null,
    editorSplitRatio: 0.5,
    activeEditorSlot: 'primary',
  } as any)
}

// 包装 EditorWorkbench：渲染时记录当前挂的是哪个 editor.id
function Probe() {
  const openEditors = useConsoleStore((s) => s.openEditors)
  const groups = useConsoleStore((s) => s.editorGroups)
  const layout = useConsoleStore((s) => s.editorLayout)
  const activeId = useConsoleStore((s) => s.activeEditorId)
  // 找当前渲染中的 group active editor 写入 mountedEditorIdRef
  const gid = (layout as any)?.groupId || groups[0]?.id
  const g = groups.find((x) => x.id === gid)
  const cur = openEditors.find((e) => e.id === (g?.activeEditorId || activeId))
  mountedEditorIdRef.current = cur?.id || null
  return React.createElement(EditorWorkbench as any, {
    onSaveEditor: async () => {},
    onOpenFile: async (f: any) => f.id,
    onOpenFileAtPosition: async (f: any) => f.id,
    onCreateCompare: async () => {},
  })
}

describe('definition jump location handoff', () => {
  beforeEach(() => {
    resolveDefinitionMock.mockReset()
    contentMock.mockReset()
    instances.byEditor = {}
    mountedEditorIdRef.current = null
  })
  afterEach(() => {
    cleanup()
    useConsoleStore.setState({
      openEditors: [],
      activeEditorId: null,
      editorGroups: [],
      editorLayout: null,
      activeEditorGroupId: null,
    } as any)
  })

  it('target NOT open: pending location applied on fresh mount', async () => {
    const entry = createEditor('local:root-ws:entry.py', 'entry.py', 'from utils.geometry import conflict_map\n')
    setState([entry], [createGroup('g1', [entry.id], entry.id)], entry.id, 'g1')
    render(React.createElement(Probe))
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...createEditor('local:root-ws:utils/geometry.py', 'utils/geometry.py', ''), line: 84, column: 5 },
    })
    contentMock.mockImplementation(async (_h: string, _r: string, path: string) => ({
      path,
      type: 'file',
      size: 10,
      modifiedAt: '',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'),
    }))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
    const targetInstances = instances.byEditor['/ws/utils/geometry.py'] || []
    console.log('target instances:', targetInstances.length)
    for (const inst of targetInstances)
      console.log(
        'setPosition calls:',
        inst.setPosition.mock.calls,
        'reveal calls:',
        inst.revealPositionInCenter.mock.calls,
      )
    expect(targetInstances.length).toBeGreaterThan(0)
    expect(targetInstances.at(-1).setPosition).toHaveBeenCalledWith({ lineNumber: 84, column: 5 })
  })

  it('target open as background tab in same group', async () => {
    const entry = createEditor('local:root-ws:entry.py', 'entry.py', 'x\n')
    const target = createEditor('local:root-ws:utils/geometry.py', 'utils/geometry.py', 'g\n')
    setState([entry, target], [createGroup('g1', [entry.id, target.id], entry.id)], entry.id, 'g1')
    render(React.createElement(Probe))
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...target, line: 84, column: 5 },
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
    const targetInstances = instances.byEditor[target.absolutePath] || []
    console.log('B target instances:', targetInstances.length)
    for (const inst of targetInstances) console.log('B setPosition calls:', inst.setPosition.mock.calls)
    expect(targetInstances.length).toBeGreaterThan(0)
    expect(targetInstances.at(-1).setPosition).toHaveBeenCalledWith({ lineNumber: 84, column: 5 })
  })

  it('target open as ACTIVE editor in another group (already mounted)', async () => {
    const entry = createEditor('local:root-ws:entry.py', 'entry.py', 'x\n')
    const target = createEditor('local:root-ws:utils/geometry.py', 'utils/geometry.py', 'g\n')
    // 单 layout 只能渲染一个 group——两组需要 split，但 renderLayout 需要 split 节点；先简化为同组后台（上一个用例）
    setState(
      [entry, target],
      [createGroup('g1', [entry.id], entry.id), createGroup('g2', [target.id], target.id)],
      entry.id,
      'g1',
    )
    useConsoleStore.setState({
      editorLayout: {
        id: 'split-1',
        type: 'split',
        direction: 'horizontal',
        first: leaf('g1'),
        second: leaf('g2'),
        ratio: 0.5,
      },
      editorSecondaryGroupIds: [target.id],
      editorSecondaryId: target.id,
      editorSplitDirection: 'horizontal',
    } as any)
    render(React.createElement(Probe))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    console.log('C mounted ids so far:', Object.keys(instances.byEditor))
    resolveDefinitionMock.mockResolvedValue({
      status: 'success',
      target: { ...target, line: 84, column: 5 },
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
    const targetInstances = instances.byEditor[target.absolutePath] || []
    console.log('C target instances:', targetInstances.length)
    for (const inst of targetInstances) console.log('C setPosition calls:', inst.setPosition.mock.calls)
    expect(targetInstances.length).toBeGreaterThan(0)
    expect(targetInstances.at(-1).setPosition).toHaveBeenCalledWith({ lineNumber: 84, column: 5 })
  })

  // 回归：pending 落位成功后目标被 loading 门重挂（openFileInEditor reload 竞态），
  // 重挂实例必须在 pending 复用窗口内重新落位，而不是停在文件开头
  it('remount after applied location re-applies pending position', async () => {
    const target = createEditor('local:root-ws:utils/geometry.py', 'utils/geometry.py', 'g\n')
    setState([target], [createGroup('g1', [target.id], target.id)], target.id, 'g1')
    render(React.createElement(Probe))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(instances.byEditor[target.absolutePath]?.length).toBe(1)

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OPEN_EDITOR_LOCATION_EVENT, {
          detail: { editorId: target.id, line: 84, column: 5 },
        }),
      )
      await new Promise((r) => setTimeout(r, 30))
    })
    const first = instances.byEditor[target.absolutePath].at(-1)
    expect(first.setPosition).toHaveBeenCalledWith({ lineNumber: 84, column: 5 })

    // 模拟 reload：loading 门卸载 Monaco 再重挂（新实例）；分 act 确保中间态真实提交
    await act(async () => {
      useConsoleStore.getState().setEditorLoaded(target.id, { loading: true })
    })
    await act(async () => {
      useConsoleStore.getState().setEditorLoaded(target.id, { loading: false, content: 'x\n'.repeat(200) })
      await new Promise((r) => setTimeout(r, 30))
    })
    const remounted = instances.byEditor[target.absolutePath]
    expect(remounted.length).toBe(2)
    expect(remounted.at(-1).setPosition).toHaveBeenCalledWith({ lineNumber: 84, column: 5 })
  })
})
