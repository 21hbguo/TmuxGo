import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './TerminalPane'
import { DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'

const onSelectionChangeHandlers: Array<() => void> = []
let customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let terminalSelection = 'printf "auto_copy_ok"'
const clipboardMocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false })),
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
  useWebSocket: () => ({ send: vi.fn() }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector: any) => selector({ activeHostId: 'local', pushToast: vi.fn() })) as any,
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
      this.element = document.createElement('div')
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
    write() {}
    dispose() {}
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
    clipboardMocks.writeClipboardText.mockClear()
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

  it('copies final selection immediately on pointer release', async () => {
    const { container } = render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "mouseup_copy_ok"'
    fireEvent.mouseUp(container.firstChild as Element)
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('printf "mouseup_copy_ok"',{preferSync:true})
    await sleep(20)
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledTimes(1)
  })

  it('retries system clipboard copy on global mouse release after browser block', async () => {
    clipboardMocks.writeClipboardText
      .mockResolvedValueOnce({ copied: true, source: 'memory', unavailable: true })
      .mockResolvedValue({ copied: true, source: 'system', unavailable: false })
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    terminalSelection = 'printf "retry_copy_ok"'
    onSelectionChangeHandlers[0]()
    await sleep(60)
    await waitFor(() => expect(clipboardMocks.writeClipboardText).toHaveBeenCalledTimes(1))
    fireEvent.mouseUp(window)
    await waitFor(() => expect(clipboardMocks.writeClipboardText).toHaveBeenCalledTimes(2))
    expect(clipboardMocks.writeClipboardText).toHaveBeenLastCalledWith('printf "retry_copy_ok"',{preferSync:true})
  })

  it('repeats ctrl backspace quickly without relying on native repeat', async () => {
    const onInput = vi.fn()
    render(<TerminalPane sessionName="dev" onInput={onInput} onResize={vi.fn()} />)
    await waitFor(() => expect(customKeyHandler).toBeTruthy())
    expect(customKeyHandler?.({ key: 'Backspace', ctrlKey: true, metaKey: false, altKey: false, repeat: false } as KeyboardEvent)).toBe(false)
    await sleep(370)
    fireEvent.keyUp(window, { key: 'Backspace', ctrlKey: true })
    expect(onInput.mock.calls.filter((call) => call[0] === DELETE_PREV_WORD_SEQUENCE).length).toBeGreaterThanOrEqual(4)
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
})
