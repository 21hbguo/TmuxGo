import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './TerminalPane'
import { DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'

const onSelectionChangeHandlers: Array<() => void> = []
let customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let terminalSelection = 'printf "auto_copy_ok"'
let terminalSelectionPosition: any = null
let terminalBufferLines: string[] = []
let terminalBaseY = 0
let resizeObserverCallback: (() => void) | null = null
const terminalMocks = vi.hoisted(() => ({
  write: vi.fn(),
  refresh: vi.fn(),
  renderClear: vi.fn(),
  clearTextureAtlas: vi.fn(),
  reset: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
}))
const terminalLifecycleMocks = vi.hoisted(() => ({
  open: vi.fn(),
  dispose: vi.fn(),
}))
const webSocketMocks = vi.hoisted(() => ({
  send: vi.fn(),
  subscribeOutput: vi.fn((listener: (message: { data: string; sessionName?: string | null }) => void) => {
    ;(webSocketMocks as any).lastOutputListener = listener
    return vi.fn()
  }),
  lastOutputListener: null as ((message: { data: string; sessionName?: string | null }) => void) | null,
}))
const clipboardMocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false, reason: 'ok' })),
}))
const storeMocks = vi.hoisted(() => ({
  pushToast: vi.fn(),
  updateTerminalPerf: vi.fn(),
  setActivePane: vi.fn(),
  openUploadDialog: vi.fn(),
}))
const queryClientMocks = vi.hoisted(() => ({
  getQueryData: vi.fn(),
  setQueryData: vi.fn(),
}))
const apiMocks = vi.hoisted(() => ({
  snapshotGet: vi.fn(async () => ({ windows: [], panes: [], activePaneId: null })),
  paneResize: vi.fn(async () => ({ ok: true })),
}))
const mobileKeyboardMocks = vi.hoisted(() => ({
  focusKeyboard: vi.fn(),
  textareaRef: { current: null as HTMLTextAreaElement | null },
  isMobile: false,
}))
const preferenceMocks = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
}))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      theme: 'dark',
      fontSize: 14,
      fontFamily: 'JetBrains Mono, monospace',
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
  }),
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ textareaRef: mobileKeyboardMocks.textareaRef, focusKeyboard: mobileKeyboardMocks.focusKeyboard, isMobile: mobileKeyboardMocks.isMobile }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: webSocketMocks.send, subscribeOutput: webSocketMocks.subscribeOutput }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign(((selector: any) => selector({ activeHostId: 'local', pushToast: storeMocks.pushToast, updateTerminalPerf: storeMocks.updateTerminalPerf, setActivePane: storeMocks.setActivePane, openUploadDialog: storeMocks.openUploadDialog, terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' } })) as any, { getState: () => ({ terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' } }) }),
}))
vi.mock('@/lib/api', () => ({
  api: { snapshot: { get: apiMocks.snapshotGet }, panes: { resize: apiMocks.paneResize } },
}))
vi.mock('@/hooks/useOptionalQueryClient', () => ({
  useOptionalQueryClient: () => queryClientMocks,
}))
vi.mock('@/lib/clipboard-text', async () => {
  const actual = await vi.importActual<typeof import('@/lib/clipboard-text')>('@/lib/clipboard-text')
  return { ...actual, writeClipboardText: clipboardMocks.writeClipboardText }
})
vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: any
    cols = 120
    rows = 36
    element: HTMLDivElement | null = null
    parser = { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })) }
    _core = {
      _renderService: { dimensions: { css: { canvas: { width: 800, height: 600 }, cell: { width: 8, height: 16 } } }, clear: terminalMocks.renderClear },
      _selectionService: { _activeSelectionMode: 0 },
      viewport: { scrollBarWidth: 0 },
    }
    buffer = {
      active: {
        get baseY() {
          return terminalBaseY
        },
        get length() {
          return terminalBufferLines.length
        },
        getLine: (index: number) => {
          const value = terminalBufferLines[index]
          if (typeof value !== 'string') return null
          return {
            translateToString: (trimRight = false, startColumn = 0, endColumn = value.length) => {
              const text = value.slice(startColumn, endColumn)
              return trimRight ? text.replace(/\s+$/g, '') : text
            },
          }
        },
      },
    }
    constructor(options: any) {
      this.options = options
    }
    loadAddon() {}
    open(container: HTMLDivElement) {
      terminalLifecycleMocks.open()
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      const rows = document.createElement('div')
      rows.className = 'xterm-rows'
      screen.appendChild(rows)
      this.element.appendChild(viewport)
      this.element.appendChild(screen)
      const input = document.createElement('textarea')
      this.element.appendChild(input)
      container.appendChild(this.element)
    }
    onData() {
      return { dispose: vi.fn() }
    }
    onSelectionChange(handler: () => void) {
      onSelectionChangeHandlers.push(handler)
      return { dispose: vi.fn() }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      customKeyHandler = handler
      return undefined
    }
    getSelection() {
      return terminalSelection
    }
    getSelectionPosition() {
      return terminalSelectionPosition
    }
    focus() {
      terminalMocks.focus()
    }
    resize() {}
    refresh(start: number, end: number) {
      terminalMocks.refresh(start, end)
    }
    clearTextureAtlas() {
      terminalMocks.clearTextureAtlas()
    }
    reset() {
      terminalMocks.reset()
    }
    clear() {
      terminalMocks.clear()
    }
    write(data: string) {
      terminalMocks.write(data)
    }
    dispose() {
      terminalLifecycleMocks.dispose()
    }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 120, rows: 36 }
    }
  },
}))
vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: class {},
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

describe('TerminalPane', () => {
  beforeEach(() => {
    onSelectionChangeHandlers.length = 0
    customKeyHandler = null
    resizeObserverCallback = null
    terminalSelection = 'printf "auto_copy_ok"'
    terminalSelectionPosition = null
    terminalBufferLines = []
    terminalBaseY = 0
    terminalMocks.write.mockClear()
    terminalMocks.refresh.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.reset.mockClear()
    terminalMocks.clear.mockClear()
    terminalMocks.focus.mockClear()
    terminalLifecycleMocks.open.mockClear()
    terminalLifecycleMocks.dispose.mockClear()
    webSocketMocks.send.mockClear()
    webSocketMocks.subscribeOutput.mockClear()
    webSocketMocks.lastOutputListener = null
    clipboardMocks.writeClipboardText.mockClear()
    storeMocks.pushToast.mockClear()
    storeMocks.updateTerminalPerf.mockClear()
    storeMocks.setActivePane.mockClear()
    storeMocks.openUploadDialog.mockClear()
    queryClientMocks.getQueryData.mockReset()
    queryClientMocks.setQueryData.mockReset()
    queryClientMocks.getQueryData.mockReturnValue(null)
    apiMocks.snapshotGet.mockClear()
    apiMocks.snapshotGet.mockResolvedValue({ windows: [], panes: [], activePaneId: null })
    apiMocks.paneResize.mockClear()
    apiMocks.paneResize.mockResolvedValue({ ok: true })
    mobileKeyboardMocks.focusKeyboard.mockClear()
    mobileKeyboardMocks.textareaRef.current = null
    mobileKeyboardMocks.isMobile = false
    preferenceMocks.updatePreferences.mockClear()
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    ;(document as Document & { execCommand?: (command: string) => boolean }).execCommand = vi.fn((command: string) => {
      if (command !== 'copy') return false
      const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: vi.fn(), getData: () => '' },
        configurable: true,
      })
      document.dispatchEvent(event)
      return true
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeObserverCallback = callback
      }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies selection to clipboard when terminal selection changes without pointer sync', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    onSelectionChangeHandlers[0]()
    await sleep(60)
    await waitFor(() => expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('printf "auto_copy_ok"',{preferSync:true}))
    expect(container.firstChild).toBeTruthy()
  })
  it('copies multiline selection within the tmux pane that contains the selection start', async () => {
    terminalSelection = 'raw selection including another pane'
    terminalSelectionPosition = { start: { x: 2, y: 0 }, end: { x: 5, y: 2 } }
    terminalBufferLines = [
      'aa0123456789|right-pane-0',
      'bb0123456789|right-pane-1',
      'cc0123456789|right-pane-2',
    ]
    queryClientMocks.getQueryData.mockReturnValue({
      sessionName: 'dev',
      activeWindowId: '@1',
      windows: [{ id: '@1', index: 0, active: true }],
      panes: [
        { id: '%1', windowId: 'dev:0', left: 0, top: 0, size: { cols: 12, rows: 10 } },
        { id: '%2', windowId: 'dev:0', left: 13, top: 0, size: { cols: 12, rows: 10 } },
      ],
    })
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    onSelectionChangeHandlers[0]()
    await waitFor(() => expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('0123456789\nbb0123456789\ncc012',{preferSync:true}))
  })
  it('resizes tmux pane through frontend border drag', async () => {
    queryClientMocks.getQueryData.mockReturnValue({
      sessionName: 'dev',
      activeWindowId: '@1',
      windows: [{ id: '@1', index: 0, active: true }],
      panes: [
        { id: '%1', windowId: 'dev:0', left: 0, top: 0, size: { cols: 12, rows: 10 } },
        { id: '%2', windowId: 'dev:0', left: 13, top: 0, size: { cols: 12, rows: 10 } },
      ],
    })
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const screen = container.querySelector('.xterm-screen') as HTMLElement
    screen.getBoundingClientRect = vi.fn(() => ({ x: 0, y: 0, left: 0, top: 0, width: 960, height: 576, right: 960, bottom: 576, toJSON: () => ({}) } as DOMRect))
    fireEvent.mouseDown(screen, { button: 0, clientX: 100, clientY: 20 })
    fireEvent.mouseMove(window, { button: 0, clientX: 124, clientY: 20 })
    await waitFor(() => expect(apiMocks.paneResize).toHaveBeenCalledWith('%1', { cols: 15 }))
    fireEvent.mouseUp(window)
  })
  it('sends final pane resize after mouseup while resize request is pending', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    apiMocks.paneResize.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve
    })).mockResolvedValue({ ok: true })
    queryClientMocks.getQueryData.mockReturnValue({
      sessionName: 'dev',
      activeWindowId: '@1',
      windows: [{ id: '@1', index: 0, active: true }],
      panes: [
        { id: '%1', windowId: 'dev:0', left: 0, top: 0, size: { cols: 12, rows: 10 } },
        { id: '%2', windowId: 'dev:0', left: 13, top: 0, size: { cols: 12, rows: 10 } },
      ],
    })
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const screen = container.querySelector('.xterm-screen') as HTMLElement
    screen.getBoundingClientRect = vi.fn(() => ({ x: 0, y: 0, left: 0, top: 0, width: 960, height: 576, right: 960, bottom: 576, toJSON: () => ({}) } as DOMRect))
    fireEvent.mouseDown(screen, { button: 0, clientX: 100, clientY: 20 })
    fireEvent.mouseMove(window, { button: 0, clientX: 108, clientY: 20 })
    await waitFor(() => expect(apiMocks.paneResize).toHaveBeenCalledWith('%1', { cols: 13 }))
    fireEvent.mouseMove(window, { button: 0, clientX: 124, clientY: 20 })
    fireEvent.mouseUp(window)
    expect(apiMocks.paneResize).toHaveBeenCalledTimes(1)
    resolveFirst({ ok: true })
    await waitFor(() => expect(apiMocks.paneResize).toHaveBeenCalledWith('%1', { cols: 15 }))
  })
  it('does not recreate terminal instance on noop rerender', async () => {
    const onInput = vi.fn()
    const onResize = vi.fn()
    const { rerender } = render(<TerminalPane sessionName="dev" onInput={onInput} onResize={onResize} />)
    await waitFor(() => expect(terminalLifecycleMocks.open).toHaveBeenCalledTimes(1))
    rerender(<TerminalPane sessionName="dev" onInput={onInput} onResize={onResize} />)
    await sleep(20)
    expect(terminalLifecycleMocks.open).toHaveBeenCalledTimes(1)
    expect(terminalLifecycleMocks.dispose).toHaveBeenCalledTimes(0)
  })
  it('does not recreate terminal instance after terminal perf updates', async () => {
    const { rerender } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} subscribeOutput={webSocketMocks.subscribeOutput} />)
    await waitFor(() => expect(terminalLifecycleMocks.open).toHaveBeenCalledTimes(1))
    terminalMocks.write.mockClear()
    webSocketMocks.lastOutputListener?.({ data: 'printf "rerender_output_ok"\\r\\n', sessionName: 'dev' })
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalledWith('printf "rerender_output_ok"\\r\\n'))
    rerender(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} subscribeOutput={webSocketMocks.subscribeOutput} />)
    await sleep(20)
    expect(terminalLifecycleMocks.open).toHaveBeenCalledTimes(1)
    expect(terminalLifecycleMocks.dispose).toHaveBeenCalledTimes(0)
  })

  it('copies final selection immediately on pointer release', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "mouseup_copy_ok"'
    fireEvent.mouseDown(container.firstChild as Element)
    fireEvent.mouseUp(container.firstChild as Element)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(storeMocks.pushToast).toHaveBeenCalledWith({ type: 'success', message: 'Copied 24 chars (native)', durationMs: 900 })
    await sleep(20)
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledTimes(0)
  })

  it('retries system clipboard copy on global mouse release after browser block', async () => {
    ;(document as Document & { execCommand?: (command: string) => boolean }).execCommand = vi.fn(() => false)
    clipboardMocks.writeClipboardText
      .mockResolvedValueOnce({ copied: true, source: 'memory', unavailable: true, reason: 'permission_denied' })
      .mockResolvedValue({ copied: true, source: 'system', unavailable: false, reason: 'ok' })
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "retry_copy_ok"'
    onSelectionChangeHandlers[0]()
    await sleep(60)
    const beforePointerRelease = clipboardMocks.writeClipboardText.mock.calls.length
    expect(beforePointerRelease).toBeGreaterThan(0)
    fireEvent.mouseDown(container.firstChild as Element)
    fireEvent.mouseUp(window)
    await waitFor(() => expect(clipboardMocks.writeClipboardText.mock.calls.length).toBeGreaterThan(beforePointerRelease))
    expect(clipboardMocks.writeClipboardText).toHaveBeenLastCalledWith('printf "retry_copy_ok"',{preferSync:true})
  })
  it('does not retry selection copy on unrelated global mouse release', async () => {
    clipboardMocks.writeClipboardText
      .mockResolvedValueOnce({ copied: true, source: 'memory', unavailable: true, reason: 'permission_denied' })
      .mockResolvedValue({ copied: true, source: 'system', unavailable: false, reason: 'ok' })
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "no_global_retry_ok"'
    onSelectionChangeHandlers[0]()
    await sleep(60)
    const beforeMouseUp = clipboardMocks.writeClipboardText.mock.calls.length
    expect(beforeMouseUp).toBeGreaterThan(0)
    fireEvent.mouseUp(window)
    await sleep(20)
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledTimes(beforeMouseUp)
  })
  it('writes terminal selection into clipboardData on native copy event', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalSelection = 'printf "copy_event_ok"'
    const target = container.querySelector('textarea') as HTMLTextAreaElement
    const setData = vi.fn()
    fireEvent.copy(target, { clipboardData: { setData, getData: () => '' } })
    expect(setData).toHaveBeenCalledWith('text/plain', 'printf "copy_event_ok"')
  })
  it('uses native copy first for ctrl/cmd c when selection exists', async () => {
    const requestCopy = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-copy', requestCopy)
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalSelection = 'printf "copy_shortcut_ok"'
    const handled = customKeyHandler?.({ key: 'c', ctrlKey: true, metaKey: false, altKey: false } as KeyboardEvent)
    expect(handled).toBe(false)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(requestCopy).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-request-terminal-copy', requestCopy)
  })
  it('keeps ctrl c for terminal interrupt when no selection exists', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalSelection = ''
    const handled = customKeyHandler?.({ key: 'c', ctrlKey: true, metaKey: false, altKey: false } as KeyboardEvent)
    expect(handled).toBe(true)
    expect(document.execCommand).not.toHaveBeenCalled()
  })
  it('deduplicates auto-copy failure toast by reason and selection', async () => {
    clipboardMocks.writeClipboardText.mockResolvedValue({ copied: true, source: 'memory', unavailable: true, reason: 'permission_denied' })
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "dedupe_toast_ok"'
    onSelectionChangeHandlers[0]()
    await sleep(80)
    expect(storeMocks.pushToast).toHaveBeenCalledTimes(1)
    expect(storeMocks.pushToast).toHaveBeenCalledWith({ type: 'info', message: 'System clipboard blocked by browser, kept in app clipboard. Press Ctrl/Cmd+C to copy.' })
  })

  it('repeats ctrl backspace quickly without relying on native repeat', async () => {
    const onInput = vi.fn()
    render(<TerminalPane sessionName="dev" onInput={onInput} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    expect(customKeyHandler?.({ key: 'Backspace', ctrlKey: true, metaKey: false, altKey: false, repeat: false } as KeyboardEvent)).toBe(false)
    await sleep(390)
    fireEvent.keyUp(window, { key: 'Backspace', ctrlKey: true })
    expect(onInput.mock.calls.filter((call) => call[0] === DELETE_PREV_WORD_SEQUENCE).length).toBeGreaterThanOrEqual(5)
    expect(customKeyHandler?.({ key: 'Backspace', ctrlKey: true, metaKey: false, altKey: false, repeat: true } as KeyboardEvent)).toBe(false)
  })

  it('routes native paste through unified paste request without fallback replay', async () => {
    const requestPaste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', requestPaste)
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    expect(customKeyHandler?.({ ctrlKey: true, metaKey: false, altKey: false, key: 'v' } as KeyboardEvent)).toBe(false)
    fireEvent.paste(container.firstChild as Element, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'printf "native_paste_once"' : '',
      },
    })
    await sleep(220)
    expect(requestPaste).toHaveBeenCalledTimes(1)
    expect(requestPaste.mock.calls[0][0].detail.text).toBe('printf "native_paste_once"')
    expect(requestPaste.mock.calls[0][0].detail.source).toBe('system')
    window.removeEventListener('tmuxgo-request-terminal-paste', requestPaste)
  })
  it('intercepts paste before target listeners can inject into terminal', async () => {
    const requestPaste = vi.fn()
    const targetPaste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', requestPaste)
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const target = container.querySelector('textarea') as HTMLTextAreaElement
    target.addEventListener('paste', targetPaste)
    fireEvent.paste(target, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'printf "blocked_direct_paste"' : '',
      },
    })
    await sleep(60)
    expect(requestPaste).toHaveBeenCalledTimes(1)
    expect(requestPaste.mock.calls[0][0].detail.text).toBe('printf "blocked_direct_paste"')
    expect(targetPaste).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-request-terminal-paste', requestPaste)
  })
  it('routes insertFromPaste input through unified paste request', async () => {
    const requestPaste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', requestPaste)
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const target = container.querySelector('textarea') as HTMLTextAreaElement
    target.value = 'printf "input_paste_path"'
    const event = new InputEvent('input', { bubbles: true, cancelable: true, data: null, inputType: 'insertFromPaste' })
    target.dispatchEvent(event)
    await sleep(60)
    expect(requestPaste).toHaveBeenCalledTimes(1)
    expect(requestPaste.mock.calls[0][0].detail.text).toBe('printf "input_paste_path"')
    expect(target.value).toBe('')
    window.removeEventListener('tmuxgo-request-terminal-paste', requestPaste)
  })

  it('falls back to app clipboard paste when native paste does not arrive', async () => {
    const requestPaste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', requestPaste)
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    expect(customKeyHandler?.({ ctrlKey: true, metaKey: false, altKey: false, key: 'v' } as KeyboardEvent)).toBe(false)
    await sleep(220)
    expect(requestPaste).toHaveBeenCalledTimes(1)
    window.removeEventListener('tmuxgo-request-terminal-paste', requestPaste)
  })

  it('does not treat Windows Meta+V as terminal paste', async () => {
    const requestPaste = vi.fn()
    window.addEventListener('tmuxgo-request-terminal-paste', requestPaste)
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    expect(customKeyHandler?.({ ctrlKey: false, metaKey: true, altKey: false, key: 'v' } as KeyboardEvent)).toBe(true)
    await sleep(220)
    expect(requestPaste).not.toHaveBeenCalled()
    window.removeEventListener('tmuxgo-request-terminal-paste', requestPaste)
  })
  it('renders terminal output from global websocket event', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-output', { detail: 'printf \"global_output_ok\"\\r\\n' }))
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalledWith('printf \"global_output_ok\"\\r\\n'))
  })
  it('renders websocket output for matching session only', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} subscribeOutput={webSocketMocks.subscribeOutput} />)
    await waitFor(() => expect(webSocketMocks.lastOutputListener).toBeTruthy())
    webSocketMocks.lastOutputListener?.({ data: 'printf "dev_only_output_ok"\\r\\n', sessionName: 'other' })
    await sleep(20)
    expect(terminalMocks.write).not.toHaveBeenCalled()
    webSocketMocks.lastOutputListener?.({ data: 'printf "dev_only_output_ok"\\r\\n', sessionName: 'dev' })
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalledWith('printf "dev_only_output_ok"\\r\\n'))
  })
  it('keeps rendered output when output arrives before first attached event', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} subscribeOutput={webSocketMocks.subscribeOutput} />)
    await waitFor(() => expect(webSocketMocks.lastOutputListener).toBeTruthy())
    terminalMocks.write.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.reset.mockClear()
    terminalMocks.clear.mockClear()
    webSocketMocks.send.mockClear()
    webSocketMocks.lastOutputListener?.({ data: 'printf "attach_race_ok"\\r\\n', sessionName: 'dev' })
    await waitFor(() => expect(terminalMocks.write).toHaveBeenCalledWith('printf "attach_race_ok"\\r\\n'))
    window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev', cols: 120, rows: 36, exclusive: true } }))
    await waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalled())
    expect(terminalMocks.clearTextureAtlas).not.toHaveBeenCalled()
    expect(terminalMocks.renderClear).not.toHaveBeenCalled()
    expect(terminalMocks.reset).not.toHaveBeenCalled()
    expect(terminalMocks.clear).not.toHaveBeenCalled()
    expect(webSocketMocks.send).toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
  })
  it('ignores stale attach events from another session', async () => {
    render(<TerminalPane sessionName="dev" attachExclusive={false} onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalMocks.refresh.mockClear()
    webSocketMocks.send.mockClear()
    window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'other', cols: 120, rows: 36, exclusive: false } }))
    await sleep(140)
    expect(terminalMocks.refresh).not.toHaveBeenCalled()
    expect(webSocketMocks.send).not.toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
    window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev', cols: 120, rows: 36, exclusive: false } }))
    await waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalled())
    expect(webSocketMocks.send).toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
  })
  it('recovers terminal renderer on attach and keeps ordinary layout changes soft', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalMocks.refresh.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.reset.mockClear()
    terminalMocks.clear.mockClear()
    webSocketMocks.send.mockClear()
    window.dispatchEvent(new CustomEvent('tmux-attached', { detail: { sessionName: 'dev', cols: 120, rows: 36, exclusive: true } }))
    await waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalled())
    expect(terminalMocks.clearTextureAtlas).toHaveBeenCalled()
    expect(terminalMocks.renderClear).toHaveBeenCalled()
    expect(terminalMocks.reset).toHaveBeenCalled()
    expect(terminalMocks.clear).toHaveBeenCalled()
    expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 35)
    expect(webSocketMocks.send).toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
    terminalMocks.refresh.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.reset.mockClear()
    terminalMocks.clear.mockClear()
    webSocketMocks.send.mockClear()
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'desktop-workbench' } }))
    await waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalled())
    expect(terminalMocks.clearTextureAtlas).not.toHaveBeenCalled()
    expect(terminalMocks.renderClear).not.toHaveBeenCalled()
    expect(terminalMocks.reset).not.toHaveBeenCalled()
    expect(terminalMocks.clear).not.toHaveBeenCalled()
    expect(webSocketMocks.send).not.toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
  })
  it('recovers terminal renderer when device pixel ratio changes', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalMocks.refresh.mockClear()
    terminalMocks.clearTextureAtlas.mockClear()
    terminalMocks.renderClear.mockClear()
    terminalMocks.reset.mockClear()
    terminalMocks.clear.mockClear()
    webSocketMocks.send.mockClear()
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    fireEvent.resize(window)
    await waitFor(() => expect(terminalMocks.clearTextureAtlas).toHaveBeenCalled())
    expect(terminalMocks.renderClear).toHaveBeenCalled()
    expect(terminalMocks.reset).toHaveBeenCalled()
    expect(terminalMocks.clear).toHaveBeenCalled()
    expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 35)
    expect(webSocketMocks.send).toHaveBeenCalledWith({ type: 'redraw', sessionName: 'dev' })
  })
  it('keeps terminal root aligned without transform offsets', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const terminalRoot = container.querySelector('.xterm') as HTMLDivElement
    expect(terminalRoot).toBeTruthy()
    expect(terminalRoot.style.transform).toBe('')
    expect(terminalRoot.style.width).toBe('100%')
    expect(terminalRoot.style.height).toBe('100%')
  })
  it('does not repaint on unchanged mobile resize observations', async () => {
    mobileKeyboardMocks.isMobile = true
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const root = container.firstChild as HTMLElement
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 390 })
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 })
    resizeObserverCallback?.()
    await sleep(140)
    terminalMocks.refresh.mockClear()
    resizeObserverCallback?.()
    await sleep(140)
    expect(terminalMocks.refresh).not.toHaveBeenCalled()
  })
  it('does not steal mobile keyboard input focus back to xterm', async () => {
    mobileKeyboardMocks.isMobile = true
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalMocks.focus.mockClear()
    const mobileInput = container.querySelector('.mobile-kb-input') as HTMLTextAreaElement
    expect(mobileInput).toBeTruthy()
    fireEvent.focus(mobileInput)
    expect(terminalMocks.focus).not.toHaveBeenCalled()
  })
  it('updates terminal font size by pinch and persists on gesture end', async () => {
    mobileKeyboardMocks.isMobile = true
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const root = container.firstChild as HTMLElement
    fireEvent.touchStart(root, {
      touches: [
        { identifier: 1, clientX: 0, clientY: 0 },
        { identifier: 2, clientX: 100, clientY: 0 },
      ],
    })
    fireEvent.touchMove(root, {
      touches: [
        { identifier: 1, clientX: 0, clientY: 0 },
        { identifier: 2, clientX: 150, clientY: 0 },
      ],
    })
    fireEvent.touchEnd(root, {
      touches: [],
      changedTouches: [
        { identifier: 2, clientX: 150, clientY: 0 },
      ],
    })
    await waitFor(() => expect(preferenceMocks.updatePreferences).toHaveBeenCalled())
    const lastCall = preferenceMocks.updatePreferences.mock.calls[preferenceMocks.updatePreferences.mock.calls.length - 1]
    expect(lastCall?.[0].fontSize).toBeGreaterThan(14)
  })
  it('keeps desktop terminal focus behavior', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    terminalMocks.focus.mockClear()
    fireEvent.focus(container.firstChild as Element)
    expect(terminalMocks.focus).toHaveBeenCalled()
  })
})
