// 复现「刷新后终端区缩放丢失」。
//
// 场景：用户用 Ctrl+滚轮把终端区放大到 terminalScale=1.25（zustand persist 落 localStorage），
// 刷新页面后 TerminalPane 重新挂载，store 里的 terminalScale 仍在，但 xterm 字号回到未缩放值。
//
// 期望：挂载完成后新建实例的 options.fontSize === round(preferences.fontSize * terminalScale) = 18。
// 当前实现：terminal-core.ts 用未乘 terminalScale 的 preferences.fontSize(=14) 构造 Terminal，
// 而 TerminalPane 里写字号的 effect 在 mount 时 terminalInstance.current 还是 null → early return，
// 之后没有任何路径把缩放字号写回 → 实际 14。
//
// 本文件只做复现，不改 src。失败即代表 bug 仍然存在。
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IBufferRange, ITerminalOptions } from '@xterm/xterm'
import { TerminalPane } from './TerminalPane'
import { useWorkspaceZoom } from '@/lib/workspace-zoom'

const PREFERENCE_FONT_SIZE = 14

const terminalMocks = vi.hoisted(() => ({
  write: vi.fn(),
  refresh: vi.fn(),
  renderClear: vi.fn(),
  clearTextureAtlas: vi.fn(),
  focus: vi.fn(),
  resize: vi.fn(),
}))
const terminalLifecycleMocks = vi.hoisted(() => ({
  open: vi.fn(),
  dispose: vi.fn(),
}))
const webSocketMocks = vi.hoisted(() => ({
  send: vi.fn(),
  subscribeOutput: vi.fn(() => vi.fn()),
}))
const storeMocks = vi.hoisted(() => ({
  pushToast: vi.fn(),
  updateTerminalPerf: vi.fn(),
  setActivePane: vi.fn(),
  openUploadDialog: vi.fn(),
  openEditor: vi.fn(),
  setEditorLoaded: vi.fn(),
  setFilePanelOpen: vi.fn(),
}))
const queryClientMocks = vi.hoisted(() => ({
  getQueryData: vi.fn(() => null),
  setQueryData: vi.fn(),
}))
const apiMocks = vi.hoisted(() => ({
  snapshotGet: vi.fn(async () => ({ windows: [], panes: [], activePaneId: null })),
  paneResize: vi.fn(async () => ({ ok: true })),
  paneSelect: vi.fn(async () => ({ ok: true })),
  githubAuthStatus: vi.fn(async () => ({ ok: true, available: true, loggedIn: false })),
  fileRoots: vi.fn(async () => [{ id: 'root-workspace', label: 'workspace', path: '/workspace' }]),
  defaultUploadTarget: vi.fn(async () => ({
    rootId: 'root-workspace',
    rootLabel: 'workspace',
    rootPath: '/workspace',
    path: '',
    absolutePath: '/workspace',
    source: 'pane',
  })),
}))
const mobileKeyboardMocks = vi.hoisted(() => ({
  focusKeyboard: vi.fn(),
  textareaRef: { current: null as HTMLTextAreaElement | null },
  isMobile: false,
}))
const preferenceMocks = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  isReady: true,
}))
// 记录 Terminal 构造函数收到的 options，便于对照「构造时用什么字号」
const terminalState = vi.hoisted(() => ({
  constructorOptions: null as ITerminalOptions | null,
  cellWidth: 8,
  cellHeight: 16,
  bufferType: 'normal' as 'normal' | 'alternate',
  cursorX: 0,
  cursorY: 0,
  baseY: 0,
  viewportY: 0,
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      theme: 'dark',
      fontSize: PREFERENCE_FONT_SIZE,
      fontFamily: '"JetBrains Mono", monospace',
      cursorBlink: true,
      sidebarPosition: 'left',
      showStatusBar: true,
      showQuickActions: true,
      autoReconnect: true,
      reconnectInterval: 3000,
      terminalPadding: 8,
      language: 'zh',
      attachExclusive: true,
    },
    updatePreferences: preferenceMocks.updatePreferences,
    isReady: preferenceMocks.isReady,
  }),
  ensureAppFontLoaded: async () => {},
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({
    textareaRef: mobileKeyboardMocks.textareaRef,
    focusKeyboard: mobileKeyboardMocks.focusKeyboard,
    isMobile: mobileKeyboardMocks.isMobile,
  }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: webSocketMocks.send, subscribeOutput: webSocketMocks.subscribeOutput }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        activeHostId: 'local',
        activePaneId: 'local:%1',
        pushToast: storeMocks.pushToast,
        updateTerminalPerf: storeMocks.updateTerminalPerf,
        setActivePane: storeMocks.setActivePane,
        openUploadDialog: storeMocks.openUploadDialog,
        terminalPerf: {
          attachLatency: 0,
          outputBytes: 0,
          outputEvents: 0,
          outputBacklog: 0,
          layoutFitCount: 0,
          lastOutputAt: '',
        },
      }),
    {
      getState: () => ({
        activePaneId: 'local:%1',
        terminalPerf: {
          attachLatency: 0,
          outputBytes: 0,
          outputEvents: 0,
          outputBacklog: 0,
          layoutFitCount: 0,
          lastOutputAt: '',
        },
        openEditors: [],
        openEditor: storeMocks.openEditor,
        setEditorLoaded: storeMocks.setEditorLoaded,
        setFilePanelOpen: storeMocks.setFilePanelOpen,
      }),
    },
  ),
}))
vi.mock('@/lib/api', () => ({
  fetchApiBlob: vi.fn(async () => new Blob(['image'])),
  api: {
    snapshot: { get: apiMocks.snapshotGet },
    panes: { resize: apiMocks.paneResize, select: apiMocks.paneSelect },
    hosts: { githubAuthStatus: apiMocks.githubAuthStatus },
    files: {
      roots: apiMocks.fileRoots,
      defaultUploadTarget: apiMocks.defaultUploadTarget,
      content: vi.fn(async () => ({
        content: '',
        modifiedAt: '2026-06-02T00:00:00.000Z',
        size: 0,
        binary: false,
        truncated: false,
      })),
      preview: vi.fn(async () => ({
        path: 'src/index.ts',
        type: 'file',
        size: 0,
        modifiedAt: '2026-06-02T00:00:00.000Z',
        binary: false,
        truncated: false,
        lines: [],
      })),
      imageUrl: vi.fn(() => '/api/files/image'),
    },
  },
}))
vi.mock('@/hooks/useOptionalQueryClient', () => ({
  useOptionalQueryClient: () => queryClientMocks,
}))
vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: ITerminalOptions
    cols = 120
    rows = 36
    element: HTMLDivElement | null = null
    textarea: HTMLTextAreaElement | null = null
    parser = { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })) }
    unicode = {
      activeVersion: '6',
      get versions() {
        return [this.activeVersion]
      },
      register: vi.fn(),
    }
    _core = {
      _renderService: {
        dimensions: {
          css: {
            canvas: { width: 800, height: 600 },
            cell: {
              get width() {
                return terminalState.cellWidth
              },
              get height() {
                return terminalState.cellHeight
              },
            },
          },
        },
        clear: terminalMocks.renderClear,
      },
      _selectionService: { _activeSelectionMode: 0 },
      viewport: { scrollBarWidth: 0 },
    }
    buffer = {
      active: {
        get type() {
          return terminalState.bufferType
        },
        get baseY() {
          return terminalState.baseY
        },
        get viewportY() {
          return terminalState.viewportY
        },
        get cursorX() {
          return terminalState.cursorX
        },
        get cursorY() {
          return terminalState.cursorY
        },
        get length() {
          return 0
        },
        getLine: () => null,
      },
    }
    constructor(options: ITerminalOptions) {
      terminalState.constructorOptions = options
      this.options = options
    }
    loadAddon(addon?: { activate?: (terminal: unknown) => void }) {
      addon?.activate?.(this)
    }
    open(container: HTMLDivElement) {
      terminalLifecycleMocks.open()
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      const rows = document.createElement('div')
      rows.className = 'xterm-rows'
      screen.appendChild(rows)
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      this.element.appendChild(viewport)
      this.element.appendChild(screen)
      const input = document.createElement('textarea')
      input.className = 'xterm-helper-textarea'
      this.textarea = input
      this.element.appendChild(input)
      container.appendChild(this.element)
    }
    onData() {
      return { dispose: vi.fn() }
    }
    onScroll() {
      return { dispose: vi.fn() }
    }
    onWriteParsed() {
      return { dispose: vi.fn() }
    }
    onResize() {
      return { dispose: vi.fn() }
    }
    onSelectionChange() {
      return { dispose: vi.fn() }
    }
    attachCustomKeyEventHandler() {
      return undefined
    }
    clearSelection() {}
    getSelection() {
      return ''
    }
    getSelectionPosition(): IBufferRange | null {
      return null
    }
    focus() {
      terminalMocks.focus()
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      terminalMocks.resize(cols, rows)
    }
    refresh() {
      terminalMocks.refresh()
    }
    clearTextureAtlas() {
      terminalMocks.clearTextureAtlas()
    }
    reset() {}
    clear() {}
    scrollToBottom() {
      terminalState.viewportY = terminalState.baseY
    }
    write(_data: string, callback?: () => void) {
      terminalMocks.write()
      callback?.()
    }
    registerLinkProvider() {
      return { dispose: vi.fn() }
    }
    dispose() {
      terminalLifecycleMocks.dispose()
    }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {
      return { dispose: vi.fn() }
    }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(_handler?: (event: MouseEvent, uri: string) => void) {}
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

type DebugWindow = typeof window & { __tmuxgoTerminal?: { options: ITerminalOptions } }

// 等终端实例真正建好（runtime 是异步 initTerminal），再断言最终字号
async function getMountedTerminal() {
  await vi.waitFor(
    () => {
      expect((window as DebugWindow).__tmuxgoTerminal).toBeTruthy()
    },
    { timeout: 3000 },
  )
  // 让 initTerminal 之后的微/宏任务（字体加载回调、首帧 snapshot 等）跑完，
  // 既避免断言落在半途，也消化 runtime 带来的异步 setState（否则会刷 act 警告）
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return (window as DebugWindow).__tmuxgoTerminal as { options: ITerminalOptions }
}

describe('TerminalPane 终端区缩放持久化', () => {
  beforeEach(() => {
    terminalState.constructorOptions = null
    terminalState.bufferType = 'normal'
    terminalState.baseY = 0
    terminalState.viewportY = 0
    terminalMocks.write.mockClear()
    terminalMocks.refresh.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.resize.mockClear()
    terminalLifecycleMocks.open.mockClear()
    terminalLifecycleMocks.dispose.mockClear()
    webSocketMocks.send.mockClear()
    webSocketMocks.subscribeOutput.mockClear()
    queryClientMocks.getQueryData.mockReturnValue(null)
    preferenceMocks.isReady = true
    window.localStorage.clear()
    delete (window as DebugWindow).__tmuxgoTerminal
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    // 每个 case 收尾都把缩放还原，避免串味
    useWorkspaceZoom.setState({ terminalScale: 1, uiScale: 1 })
    delete (window as DebugWindow).__tmuxgoTerminal
  })

  // 对照组：scale=1 时字号就是 preferences.fontSize，证明测试管线能读到真实创建的实例
  it('未缩放时挂载得到的字号等于 preferences.fontSize', async () => {
    useWorkspaceZoom.setState({ terminalScale: 1, uiScale: 1 })
    const view = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    try {
      const terminal = await getMountedTerminal()
      expect(terminalState.constructorOptions?.fontSize).toBe(PREFERENCE_FONT_SIZE)
      expect(terminal.options.fontSize).toBe(PREFERENCE_FONT_SIZE)
    } finally {
      act(() => view.unmount())
    }
  })

  // 复现 case：刷新后 store 里 terminalScale=1.25，新实例必须直接用缩放后的字号
  it('刷新后 terminalScale=1.25 时挂载得到的字号应为缩放后的 18', async () => {
    useWorkspaceZoom.setState({ terminalScale: 1.25, uiScale: 1 })
    const view = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    try {
      const terminal = await getMountedTerminal()
      expect(terminal.options.fontSize).toBe(Math.round(PREFERENCE_FONT_SIZE * 1.25))
    } finally {
      act(() => view.unmount())
    }
  })
})
