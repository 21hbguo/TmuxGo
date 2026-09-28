import React, { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserView, normalizeBrowserAddress } from './BrowserView'
import { useConsoleStore } from '@/stores/useConsoleStore'

const { launchMock, stopMock, navigateMock, setupMock, statusMock, pickMock, pickCancelMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  stopMock: vi.fn(),
  navigateMock: vi.fn(),
  setupMock: vi.fn(),
  statusMock: vi.fn(),
  pickMock: vi.fn(),
  pickCancelMock: vi.fn(),
}))

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
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
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}
// Image 在 jsdom 不解码：src 赋值后异步触发 onload，走 drawFrame 的完整路径
class MockImage {
  naturalWidth = 640
  naturalHeight = 480
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}
vi.stubGlobal('WebSocket', MockWebSocket)
vi.stubGlobal('Image', MockImage)
vi.mock('@/lib/auth', () => ({
  getWebSocketUrl: vi.fn(async (base: string) => `${base}?ticket=t1`),
}))
vi.mock('@/lib/api', () => ({
  api: {
    browser: {
      status: statusMock,
      setup: setupMock,
      launch: launchMock,
      stop: stopMock,
      navigate: navigateMock,
      pick: pickMock,
      pickCancel: pickCancelMock,
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const drawImage = vi.fn()
const lastWs = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]
const sentMsgs = (ws: MockWebSocket) => ws.sent.map((raw) => JSON.parse(raw))
const renderView = () =>
  render(<BrowserView hostId="local" view="full" onViewChange={vi.fn()} onMinimize={vi.fn()} onClose={vi.fn()} />)
const openWs = async () => {
  await waitFor(() => expect(lastWs()).toBeTruthy())
  await act(async () => {
    lastWs().open()
  })
}
// 让 canvas/stage 在 jsdom 里有非零显示尺寸：坐标换算依赖 getBoundingClientRect
const stubRect = (el: Element, w = 800, h = 600) => {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    width: w,
    height: h,
    left: 0,
    top: 0,
    right: w,
    bottom: h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

describe('BrowserView', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    drawImage.mockReset()
    launchMock.mockReset().mockResolvedValue({ state: 'ready' })
    stopMock.mockReset().mockResolvedValue({ ok: true })
    navigateMock.mockReset().mockResolvedValue({ ok: true })
    setupMock.mockReset().mockResolvedValue({ status: { installed: true, binary: '/usr/bin/chromium' }, hint: '' })
    statusMock.mockReset().mockResolvedValue({ state: 'idle' })
    pickMock.mockReset().mockResolvedValue({ ok: true, result: { cancelled: true } })
    pickCancelMock.mockReset().mockResolvedValue({ ok: true })
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ drawImage }),
    })
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    useConsoleStore.setState({ pushToast: vi.fn(), toasts: [] })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  // ready + 已喂帧，避免 readyRebind 重连干扰断言；targets 带出 activeTargetId 供 pick 指认
  const renderReady = async (targets?: { id: string; url: string; title: string }[]) => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
      if (targets) lastWs().message({ type: 'targets', activeTargetId: targets[0].id, targets })
    })
    return lastWs()
  }

  it('connects to the browser stream websocket through the ticket URL', async () => {
    renderView()
    await waitFor(() => expect(lastWs()).toBeTruthy())
    expect(lastWs().url).toContain('/api/browser/stream')
    expect(lastWs().url).toContain('ticket=t1')
  })

  it('shows launch UI on idle status and calls launch on click', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'idle' })
    })
    const launchBtn = screen.getByRole('button', { name: 'browser.launch' })
    fireEvent.click(launchBtn)
    await waitFor(() => expect(launchMock).toHaveBeenCalledTimes(1))
  })

  it('renders tabs from targets and forwards activate/close/open', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
    })
    await act(async () => {
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
      lastWs().message({
        type: 'targets',
        activeTargetId: 't1',
        targets: [
          { id: 't1', url: 'https://a.dev', title: 'Alpha' },
          { id: 't2', url: 'https://b.dev', title: 'Beta' },
        ],
      })
    })
    // status ready 时还没帧 → 触发一次补绑重连；上面已喂帧则用当前 socket
    const ws = lastWs()
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(sentMsgs(ws)).toContainEqual({ type: 'tab', action: 'activate', targetId: 't2' })
    fireEvent.click(screen.getAllByRole('button', { name: 'browser.closeTab' })[0])
    expect(sentMsgs(ws)).toContainEqual({ type: 'tab', action: 'close', targetId: 't1' })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newTab' }))
    expect(sentMsgs(ws)).toContainEqual({ type: 'tab', action: 'open', url: 'about:blank' })
  })

  it('navigates on address Enter with search fallback for bare words', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    const ws = lastWs()
    const input = screen.getByPlaceholderText('browser.addressPlaceholder')
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sentMsgs(ws)).toContainEqual({ type: 'navigate', url: 'https://example.com' })
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sentMsgs(ws)).toContainEqual({ type: 'navigate', url: 'https://www.bing.com/search?q=hello%20world' })
  })

  it('maps pointer coordinates from canvas CSS pixels to page coordinates', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    const ws = lastWs()
    const canvas = document.querySelector('canvas')!
    stubRect(canvas, 800, 600)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 400, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(canvas, { button: 0, clientX: 400, clientY: 300, pointerId: 1 })
    const msgs = sentMsgs(ws)
    expect(msgs).toContainEqual({ type: 'input', kind: 'mousedown', x: 800, y: 600, button: 'left' })
    expect(msgs).toContainEqual({ type: 'input', kind: 'mouseup', x: 800, y: 600, button: 'left' })
    // 画布中心一半 → 页面 (800,600)：1600×1200 帧按显示尺寸线性换算
  })

  it('forwards wheel deltas through the native listener', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    const ws = lastWs()
    const canvas = document.querySelector('canvas')!
    stubRect(canvas, 800, 600)
    await act(async () => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: 200,
          clientY: 150,
          deltaX: 0,
          deltaY: 120,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(sentMsgs(ws)).toContainEqual({ type: 'input', kind: 'wheel', x: 400, y: 300, deltaX: 0, deltaY: 120 })
  })

  it('sends keydown plus char for printable keys and only keydown for Enter', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    const ws = lastWs()
    const kbd = screen.getByLabelText('browser.keyboardInput')
    fireEvent.keyDown(kbd, { key: 'a', code: 'KeyA' })
    fireEvent.keyUp(kbd, { key: 'a', code: 'KeyA' })
    const msgs = sentMsgs(ws)
    expect(msgs).toContainEqual({ type: 'input', kind: 'keydown', key: 'a', code: 'KeyA' })
    expect(msgs).toContainEqual({ type: 'input', kind: 'char', key: '', code: '', text: 'a' })
    expect(msgs).toContainEqual({ type: 'input', kind: 'keyup', key: 'a', code: 'KeyA' })
    fireEvent.keyDown(kbd, { key: 'Enter', code: 'Enter' })
    expect(sentMsgs(ws)).toContainEqual({ type: 'input', kind: 'keydown', key: 'Enter', code: 'Enter' })
    expect(sentMsgs(ws).filter((m) => m.kind === 'char' && m.text === 'Enter')).toHaveLength(0)
  })

  it('sends composition text as a single char message on compositionend', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    const ws = lastWs()
    const kbd = screen.getByLabelText('browser.keyboardInput')
    fireEvent.compositionStart(kbd)
    fireEvent.compositionEnd(kbd, { data: '中文' })
    expect(sentMsgs(ws)).toContainEqual({ type: 'input', kind: 'char', key: '', code: '', text: '中文' })
  })

  it('reconnects once when reaching ready without an active page binding', async () => {
    vi.useFakeTimers()
    try {
      renderView()
      await act(async () => {
        await Promise.resolve()
      })
      const first = lastWs()
      await act(async () => {
        first.open()
      })
      // idle 期连上的 socket 没被 gateway 绑 page：ready 后超过宽限仍无帧 → 重连补绑
      await act(async () => {
        first.message({ type: 'status', state: 'idle' })
        first.message({ type: 'status', state: 'ready' })
      })
      await act(async () => {
        vi.advanceTimersByTime(750)
        await Promise.resolve()
      })
      expect(MockWebSocket.instances.length).toBe(2)
      expect(first.readyState).toBe(MockWebSocket.CLOSED)
      // 第二 socket 正常收帧后不再连环重连
      const second = lastWs()
      await act(async () => {
        second.open()
        second.message({ type: 'status', state: 'ready' })
        second.message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(MockWebSocket.instances.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows disconnected overlay and reconnects when the socket drops', async () => {
    vi.useFakeTimers()
    try {
      renderView()
      await act(async () => {
        await Promise.resolve()
      })
      const ws = lastWs()
      await act(async () => {
        ws.open()
        ws.message({ type: 'status', state: 'ready' })
        ws.message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
      })
      await act(async () => {
        ws.drop()
      })
      // 头部状态与遮罩都会渲染 disconnected 文案
      expect(screen.getAllByText('browser.disconnected').length).toBeGreaterThan(0)
      await act(async () => {
        vi.advanceTimersByTime(1500)
        await Promise.resolve()
      })
      expect(MockWebSocket.instances.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables the pick button until the engine is ready', async () => {
    renderView()
    await openWs()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'idle' })
    })
    expect(screen.getByRole('button', { name: 'browser.pick' })).toBeDisabled()
    await act(async () => {
      lastWs().message({ type: 'status', state: 'ready' })
      lastWs().message({ type: 'frame', data: 'eXt==', width: 1600, height: 1200 })
    })
    expect(screen.getByRole('button', { name: 'browser.pick' })).toBeEnabled()
  })

  it('starts pick on the active target and shows the result card', async () => {
    let resolvePick: (value: unknown) => void = () => {}
    pickMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePick = resolve
      }),
    )
    await renderReady([{ id: 't1', url: 'https://a.dev', title: 'Alpha' }])
    fireEvent.click(screen.getByRole('button', { name: 'browser.pick' }))
    await waitFor(() => expect(pickMock).toHaveBeenCalledWith('t1'))
    // 拾取态按钮变「取消选择」
    expect(screen.getByRole('button', { name: 'browser.pickCancel' })).toBeTruthy()
    await act(async () => {
      resolvePick({
        ok: true,
        result: {
          selector: '#main > button',
          ref: 'p3',
          tag: 'button',
          text: 'Buy now',
          rect: { x: 1, y: 2, width: 3, height: 4 },
          url: 'https://a.dev',
          title: 'Alpha',
        },
      })
    })
    expect(screen.getByText('#main > button')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'browser.pickCopySelector' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('#main > button'))
    fireEvent.click(screen.getByRole('button', { name: 'browser.pickCopyRef' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('p3'))
    // header 与结果卡各有一个 close：卡片在 DOM 中居后
    const closes = screen.getAllByRole('button', { name: 'common.close' })
    fireEvent.click(closes[closes.length - 1])
    expect(screen.queryByText('#main > button')).toBeNull()
  })

  it('resets the button when pick resolves cancelled or fails', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: 'browser.pick' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'browser.pickCancel' })).toBeTruthy())
    // 默认 mock 即返回 cancelled：不出现结果卡
    await waitFor(() => expect(screen.getByRole('button', { name: 'browser.pick' })).toBeTruthy())
    const pushToast = useConsoleStore.getState().pushToast
    pickMock.mockRejectedValue(Object.assign(new Error('HTTP 409'), { status: 409 }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.pick' }))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith({ type: 'error', message: 'browser.pickBusy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'browser.pick' })).toBeTruthy())
  })

  it('cancels an in-flight pick via the cancel button', async () => {
    pickMock.mockReturnValue(new Promise(() => {}))
    await renderReady([{ id: 't1', url: 'https://a.dev', title: 'Alpha' }])
    fireEvent.click(screen.getByRole('button', { name: 'browser.pick' }))
    await waitFor(() => expect(pickMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'browser.pickCancel' }))
    await waitFor(() => expect(pickCancelMock).toHaveBeenCalledWith('t1'))
    expect(screen.getByRole('button', { name: 'browser.pick' })).toBeTruthy()
  })

  it('cancels pick when the active target switches mid-pick', async () => {
    pickMock.mockReturnValue(new Promise(() => {}))
    const ws = await renderReady([{ id: 't1', url: 'https://a.dev', title: 'Alpha' }])
    fireEvent.click(screen.getByRole('button', { name: 'browser.pick' }))
    await waitFor(() => expect(pickMock).toHaveBeenCalled())
    await act(async () => {
      ws.message({
        type: 'targets',
        activeTargetId: 't2',
        targets: [
          { id: 't1', url: 'https://a.dev', title: 'Alpha' },
          { id: 't2', url: 'https://b.dev', title: 'Beta' },
        ],
      })
    })
    await waitFor(() => expect(pickCancelMock).toHaveBeenCalledWith('t1'))
  })
})

describe('normalizeBrowserAddress', () => {
  it('passes through explicit schemes and prefixes bare domains', () => {
    expect(normalizeBrowserAddress('http://a.dev/x')).toBe('http://a.dev/x')
    expect(normalizeBrowserAddress('about:blank')).toBe('about:blank')
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com')
    expect(normalizeBrowserAddress('localhost:8080')).toBe('https://localhost:8080')
    expect(normalizeBrowserAddress('  ')).toBe('')
  })
})
