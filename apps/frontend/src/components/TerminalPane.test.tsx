import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './TerminalPane'

const onSelectionChangeHandlers: Array<() => void> = []
const clipboardMocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false })),
}))

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
  useConsoleStore: ((selector: any) => selector({ activeHostId: 'local' })) as any,
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
    attachCustomKeyEventHandler() {
      return undefined
    }
    getSelection() {
      return 'printf "auto_copy_ok"'
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

  it('copies selection to clipboard when terminal selection changes', async () => {
    render(<TerminalPane sessionName="dev" onInput={vi.fn()} onResize={vi.fn()} />)
    await waitFor(() => expect(onSelectionChangeHandlers.length).toBeGreaterThan(0))
    onSelectionChangeHandlers[0]()
    await waitFor(() => expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('printf "auto_copy_ok"'))
  })
})
