import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './TerminalPane'
import { DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'

const onSelectionChangeHandlers: Array<() => void> = []
let customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let terminalSelection = 'printf "auto_copy_ok"'
const terminalMocks = vi.hoisted(() => ({
  write: vi.fn(),
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
  }),
}))
vi.mock('@/hooks/useMobileKeyboard', () => ({
  useMobileKeyboard: () => ({ textareaRef: { current: null }, focusKeyboard: vi.fn(), isMobile: false }),
}))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: webSocketMocks.send, subscribeOutput: webSocketMocks.subscribeOutput }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector: any) => selector({ activeHostId: 'local', pushToast: storeMocks.pushToast, updateTerminalPerf: storeMocks.updateTerminalPerf, setActivePane: storeMocks.setActivePane, openUploadDialog: storeMocks.openUploadDialog, terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' } })) as any,
}))
vi.mock('@/lib/api', () => ({
  api: { snapshot: { get: vi.fn(async () => ({ windows: [], panes: [], activePaneId: null })) } },
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
      _renderService: { dimensions: { css: { canvas: { width: 800, height: 600 }, cell: { width: 8, height: 16 } } } },
      viewport: { scrollBarWidth: 0 },
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
    focus() {}
    resize() {}
    refresh() {}
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
    proposeDimensions() {
      return { cols: 120, rows: 36 }
    }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

describe('TerminalPane', () => {
  beforeEach(() => {
    onSelectionChangeHandlers.length = 0
    customKeyHandler = null
    terminalSelection = 'printf "auto_copy_ok"'
    terminalMocks.write.mockClear()
    terminalLifecycleMocks.open.mockClear()
    terminalLifecycleMocks.dispose.mockClear()
    clipboardMocks.writeClipboardText.mockClear()
    storeMocks.pushToast.mockClear()
    storeMocks.updateTerminalPerf.mockClear()
    storeMocks.setActivePane.mockClear()
    storeMocks.openUploadDialog.mockClear()
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
  it('keeps terminal root aligned without transform offsets', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    const terminalRoot = container.querySelector('.xterm') as HTMLDivElement
    expect(terminalRoot).toBeTruthy()
    expect(terminalRoot.style.transform).toBe('')
    expect(terminalRoot.style.width).toBe('100%')
    expect(terminalRoot.style.height).toBe('100%')
  })
})
