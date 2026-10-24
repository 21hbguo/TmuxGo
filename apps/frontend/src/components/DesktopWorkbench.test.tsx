import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopWorkbench } from './DesktopWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FileEditorDocument } from '@/types'

const contentMock = vi.fn()
const previewMock = vi.fn()
const { dockPropsMock } = vi.hoisted(() => ({ dockPropsMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  fetchApiBlob: vi.fn(async () => new Blob(['image'])),
  api: {
    files: {
      content: (...args: unknown[]) => contentMock(...args),
      preview: (...args: unknown[]) => previewMock(...args),
      imageUrl: vi.fn(() => '/api/files/image'),
      saveContent: vi.fn(),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./ActivityBar', () => ({
  ActivityBar: () => React.createElement('div', null, 'activity'),
}))
vi.mock('./FilePanel', () => ({
  FilePanel: () => React.createElement('div', null, 'files'),
}))
vi.mock('./GitPanel', () => ({
  GitPanel: () => React.createElement('div', null, 'git'),
}))
vi.mock('./SessionPanel', () => ({
  SessionPanel: () => React.createElement('div', null, 'sessions'),
}))
vi.mock('./SessionRail', () => ({
  SessionRail: () => React.createElement('div', null, 'rail'),
}))
vi.mock('./EditorWorkbench', () => ({
  EditorWorkbench: () => React.createElement('div', null, 'editor'),
}))
vi.mock('./TerminalDock', () => ({
  TerminalDock: (props: Record<string, unknown>) => {
    dockPropsMock(props)
    return React.createElement('div', null, 'terminal')
  },
}))

describe('DesktopWorkbench', () => {
  beforeEach(() => {
    contentMock.mockReset()
    previewMock.mockReset()
    dockPropsMock.mockReset()
    // jsdom 无 pretendToBeVisual 不提供 rAF：拖拽预览走 rAF，补同步桩
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        cb(0)
        return 0
      }) as typeof window.requestAnimationFrame
      window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame
    }
    useConsoleStore.setState({
      activeHostId: 'local',
      sessionPanelExpanded: true,
      sessionPanelWidth: 248,
      sidePanelWidth: 240,
      filePanelOpen: false,
      gitPanelOpen: false,
      sshPanelOpen: false,
      fleetPanelOpen: false,
      endpointsPanelOpen: false,
      activePluginView: null,
      terminalPanelHeight: 300,
      openEditors: [
        {
          id: 'local:root-workspace:src/index.ts',
          hostId: 'local',
          rootId: 'root-workspace',
          rootLabel: 'Workspace',
          rootPath: '/workspace',
          path: 'src/index.ts',
          name: 'index.ts',
          absolutePath: '/workspace/src/index.ts',
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
        },
      ] as unknown as FileEditorDocument[],
      activeEditorId: 'local:root-workspace:src/index.ts',
      editorsHydrated: true,
    })
  })

  it('reloads content when reopening an existing empty editor', async () => {
    contentMock.mockResolvedValue({
      path: 'src/index.ts',
      type: 'file',
      size: 12,
      modifiedAt: '2026-06-02T00:00:00.000Z',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: 'const value=1',
    })
    render(React.createElement(DesktopWorkbench))
    await waitFor(() => expect(contentMock).toHaveBeenCalledWith('local', 'root-workspace', 'src/index.ts'))
    await waitFor(() =>
      expect(useConsoleStore.getState().openEditors[0]).toMatchObject({
        content: 'const value=1',
        savedContent: 'const value=1',
        size: 12,
        loading: false,
        modifiedAt: '2026-06-02T00:00:00.000Z',
      }),
    )
  })

  it('does not request file content for git-diff editors during hydration', async () => {
    useConsoleStore.setState({
      openEditors: [
        useConsoleStore.getState().openEditors[0],
        {
          id: 'git-diff?repo=%2Fworkspace',
          hostId: 'local',
          rootId: 'git',
          rootLabel: 'Git',
          rootPath: '/workspace',
          path: '',
          name: 'changes',
          absolutePath: '',
          language: 'diff',
          content: '',
          savedContent: '',
          modifiedAt: '',
          size: 0,
          dirty: false,
          loading: true,
          saving: false,
          binary: false,
          truncated: false,
        },
      ] as unknown as FileEditorDocument[],
    })
    render(React.createElement(DesktopWorkbench))
    await waitFor(() => expect(contentMock).toHaveBeenCalledWith('local', 'root-workspace', 'src/index.ts'))
    expect(contentMock).toHaveBeenCalledTimes(1)
    expect(contentMock).not.toHaveBeenCalledWith('local', 'git', expect.anything())
  })

  // 1440 视口：sessionPanelMin=230、收起到窄栏阈值 raw<182、窄栏拖出展开阈值 raw>169
  it('collapses the session panel when the resize drag ends past the collapse threshold', () => {
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 200 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(false)
    expect(useConsoleStore.getState().sessionPanelWidth).toBe(248)
  })
  it('keeps the session panel expanded and updates width when the drag ends above the threshold', () => {
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 300 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(true)
    expect(useConsoleStore.getState().sessionPanelWidth).toBe(244)
  })
  it('expands the session rail when the rail edge is dragged past the expand threshold', () => {
    useConsoleStore.setState({ sessionPanelExpanded: false })
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 400 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(true)
    expect(useConsoleStore.getState().sessionPanelWidth).toBe(316)
  })
  it('keeps the session rail collapsed when the rail edge drag stays below the threshold', () => {
    useConsoleStore.setState({ sessionPanelExpanded: false })
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(false)
  })

  // 简报 §1.3 P0-3：Fleet 也是同宽侧面板，必须从主工作区宽度里扣掉；漏扣会让终端拖拽越界压垮主体
  it('subtracts the fleet panel from the workspace width', () => {
    // 清空编辑器，避免「恢复编辑器自动打开文件面板」把侧面板计数搅进这条几何断言
    useConsoleStore.setState({ openEditors: [], activeEditorId: null })
    render(React.createElement(DesktopWorkbench))
    // 1440 视口：activity 56 + session 248 = 304，无侧面板时主工作区 1136
    expect(dockPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dragViewportWidth: 1136 }))
    act(() => useConsoleStore.setState({ fleetPanelOpen: true }))
    // 侧面板 240 打开后主工作区只剩 896，终端最大宽度同步收紧到 736
    expect(dockPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dragViewportWidth: 896, maxWidth: 736 }))
  })
  it('stops the side panel resize at the workspace minimum width', () => {
    act(() => useConsoleStore.setState({ fleetPanelOpen: true, openEditors: [], activeEditorId: null }))
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('[data-resize-handle="side-panel"]') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 2000 })
    fireEvent.mouseUp(window)
    // (1440 - 304 - 560) = 576 上限，主工作区保留 560 最小宽度
    expect(useConsoleStore.getState().sidePanelWidth).toBe(576)
    expect(dockPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ dragViewportWidth: 560 }))
  })

  // 验收：resize / 面板开关都不得卸载终端（xterm 重挂载会掉输出、闪黑）
  it('keeps the terminal mounted across panel toggles and resize drags', () => {
    useConsoleStore.setState({ openEditors: [], activeEditorId: null })
    const { container } = render(React.createElement(DesktopWorkbench))
    const terminal = screen.getByText('terminal')
    expect(terminal).toBeTruthy()
    act(() => useConsoleStore.setState({ fleetPanelOpen: true }))
    expect(screen.getByText('terminal')).toBe(terminal)
    act(() => useConsoleStore.setState({ fleetPanelOpen: false, sessionPanelExpanded: false }))
    expect(screen.getByText('terminal')).toBe(terminal)
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 400 })
    fireEvent.mouseUp(window)
    expect(screen.getByText('terminal')).toBe(terminal)
    expect(screen.getAllByText('terminal')).toHaveLength(1)
  })

  it('opens a dragged file dropped onto the empty editor area with a side-docked terminal', async () => {
    useConsoleStore.setState({ openEditors: [], activeEditorId: null, terminalDock: 'right' })
    contentMock.mockResolvedValue({
      path: 'src/dropped.ts',
      type: 'file',
      size: 10,
      modifiedAt: '2026-06-02T00:00:00.000Z',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: 'const x=1',
    })
    const { container } = render(React.createElement(DesktopWorkbench))
    const dropArea = container.querySelector('[data-editor-drop]') as HTMLElement
    expect(dropArea).toBeTruthy()
    expect(dropArea.textContent).toBe('editor.emptyArea')
    const file = {
      id: 'local:root-workspace:src/dropped.ts',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/dropped.ts',
      name: 'dropped.ts',
      absolutePath: '/workspace/src/dropped.ts',
      type: 'file',
    }
    const dataTransfer = {
      dropEffect: '',
      types: ['application/x-tmuxgo-file'],
      getData: (type: string) => (type === 'application/x-tmuxgo-file' ? JSON.stringify(file) : ''),
      setData: vi.fn(),
    }
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer })
    dropArea.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    await act(async () => {
      dropArea.dispatchEvent(drop)
    })
    await waitFor(() => expect(contentMock).toHaveBeenCalledWith('local', 'root-workspace', 'src/dropped.ts'))
    await waitFor(() => expect(useConsoleStore.getState().openEditors.some((item) => item.id === file.id)).toBe(true))
  })
})
