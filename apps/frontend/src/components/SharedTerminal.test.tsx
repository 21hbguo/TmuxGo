import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharedTerminal } from './SharedTerminal'
import { __resetViewIdForTest, getViewId } from '@/lib/view-identity'

vi.mock('@/lib/runtime-endpoints', () => ({
  getApiBase: () => 'http://api.test',
  getWebSocketBase: () => 'ws://api.test/ws',
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
// 只在断言 attach 报文：xterm 用最小替身，避免 jsdom 里跑真终端
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    constructor(_options: unknown) {}
    attachCustomKeyEventHandler(_handler: unknown) {}
    open(_element: HTMLElement) {}
    write(_data: string) {}
    dispose() {}
  },
}))

class MockWebSocket {
  static instances: MockWebSocket[] = []
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

describe('SharedTerminal view identity', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    window.localStorage.clear()
    window.sessionStorage.clear()
    __resetViewIdForTest()
    window.history.replaceState(null, '', '/share#token=share-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    __resetViewIdForTest()
    window.history.replaceState(null, '', '/')
  })

  it('sends the browser viewId when attaching from the read-only share page', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ticket: 'ticket-1', hostId: 'local', sessionName: 'demo' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SharedTerminal />)
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1))
    const socket = MockWebSocket.instances[0]!
    act(() => socket.onopen?.())
    expect(socket.sent).toHaveLength(1)
    const payload = JSON.parse(socket.sent[0]!) as Record<string, unknown>
    expect(payload).toMatchObject({
      type: 'attach',
      hostId: 'local',
      sessionName: 'demo',
      exclusive: false,
    })
    // ticket 鉴权路径不变，只是多带一个浏览器视角
    expect(payload.viewId).toMatch(/^[0-9a-f]{32}$/)
    expect(payload.viewId).toBe(getViewId())
  })
})
