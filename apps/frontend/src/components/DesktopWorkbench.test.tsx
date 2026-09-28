import { fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopWorkbench } from './DesktopWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'

const contentMock = vi.fn()
const previewMock = vi.fn()

vi.mock('@/lib/api', () => ({
  fetchApiBlob: vi.fn(async () => new Blob(['image'])),
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
      preview: (...args: any[]) => previewMock(...args),
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
  TerminalDock: () => React.createElement('div', null, 'terminal'),
}))

describe('DesktopWorkbench', () => {
  beforeEach(() => {
    contentMock.mockReset()
    previewMock.mockReset()
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
      filePanelWidth: 240,
      filePanelOpen: false,
      gitPanelOpen: false,
      gitPanelWidth: 320,
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
      ],
      activeEditorId: 'local:root-workspace:src/index.ts',
      editorsHydrated: true,
    } as any)
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
      ],
    } as any)
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
    useConsoleStore.setState({ sessionPanelExpanded: false } as any)
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 400 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(true)
    expect(useConsoleStore.getState().sessionPanelWidth).toBe(316)
  })
  it('keeps the session rail collapsed when the rail edge drag stays below the threshold', () => {
    useConsoleStore.setState({ sessionPanelExpanded: false } as any)
    const { container } = render(React.createElement(DesktopWorkbench))
    const handle = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().sessionPanelExpanded).toBe(false)
  })
})
