import React, { act } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopView } from './DesktopView'
import { useConsoleStore } from '@/stores/useConsoleStore'

const {
  getPasswordMock,
  setPasswordMock,
  deletePasswordMock,
  displaysMock,
  sendCredentialsMock,
  sendKeyMock,
  handleMouseMoveMock,
  handleMouseButtonMock,
  cursorMoveMock,
  MockRFB,
} = vi.hoisted(() => {
  const sendCredentials = vi.fn()
  const sendKey = vi.fn()
  const handleMouseMove = vi.fn()
  // 同步 _mouseButtonMask：适配层按它分流 move/button，mock 与真实行为一致才能测对路径
  const handleMouseButton = vi.fn(function (this: { _mouseButtonMask: number }, _x: number, _y: number, mask: number) {
    this._mouseButtonMask = mask
  })
  const cursorMove = vi.fn()
  class RFB {
    static instances: RFB[] = []
    handlers = new Map<string, ((event: { detail: any }) => void)[]>()
    sendCredentials = sendCredentials
    sendKey = sendKey
    disconnect = vi.fn()
    clipboardPasteFrom = vi.fn()
    scaleViewport = false
    viewOnly = false
    qualityLevel = 0
    compressionLevel = 0
    _mouseButtonMask = 0
    _mousePos = { x: 0, y: 0 }
    _cursor = { move: cursorMove }
    _handleMouseMove = handleMouseMove
    _handleMouseButton = handleMouseButton
    constructor(
      public target: HTMLElement,
      public url: string,
      public options: unknown,
    ) {
      // 真实 RFB 在容器内建 canvas（tabIndex=-1 可聚焦收键盘事件），触控适配层以它为坐标基准
      const canvas = document.createElement('canvas')
      canvas.tabIndex = -1
      target.appendChild(canvas)
      RFB.instances.push(this)
    }
    addEventListener(type: string, fn: (event: { detail: any }) => void) {
      const list = this.handlers.get(type) || []
      list.push(fn)
      this.handlers.set(type, list)
    }
    removeEventListener() {}
    emit(type: string, detail: any) {
      for (const fn of this.handlers.get(type) || []) fn({ detail })
    }
  }
  return {
    getPasswordMock: vi.fn(),
    setPasswordMock: vi.fn(),
    deletePasswordMock: vi.fn(),
    displaysMock: vi.fn(),
    sendCredentialsMock: sendCredentials,
    sendKeyMock: sendKey,
    handleMouseMoveMock: handleMouseMove,
    handleMouseButtonMock: handleMouseButton,
    cursorMoveMock: cursorMove,
    MockRFB: RFB,
  }
})

vi.mock('@novnc/novnc', () => ({ default: MockRFB }))
vi.mock('@/lib/auth', () => ({ getWebSocketUrl: vi.fn().mockResolvedValue('ws://test/vnc') }))
vi.mock('@/lib/runtime-endpoints', () => ({ getVncWebSocketBase: () => '/vnc' }))
vi.mock('@/lib/api', () => ({
  api: {
    vnc: {
      displays: displaysMock,
      displayAction: vi.fn(),
      status: vi.fn(),
      setup: vi.fn(),
      getPassword: getPasswordMock,
      setPassword: setPasswordMock,
      deletePassword: deletePasswordMock,
    },
  },
}))
vi.mock('@/lib/vnc-clipboard', () => ({
  attachVncClipboardSync: () => ({ onServerClipboard: vi.fn(), dispose: vi.fn() }),
}))
vi.mock('@/lib/vnc-tuning', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return {
    ...original,
    attachVncInstrumentation: () => ({
      sample: () => ({ fps: 0, inKbps: 0, outKbps: 0 }),
      setMaxFps: vi.fn(),
      setLossless: vi.fn(),
      dispose: vi.fn(),
    }),
    installVncRequestThrottle: vi.fn(),
    installVncLosslessFilter: vi.fn(),
    applyVncResolution: () => () => {},
    measureVncRtt: vi.fn().mockResolvedValue(5),
    writeVncPort: vi.fn(),
  }
})
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'vnc.displays': 'Displays',
        'vnc.displaysLoading': 'Scanning',
        'vnc.displayStart': 'Start',
        'vnc.displayStop': 'Stop',
        'vnc.customPort': 'Custom port',
        'vnc.credentialsRequired': 'VNC authentication required',
        'vnc.username': 'Username',
        'vnc.password': 'Password',
        'vnc.rememberPassword': 'Remember password',
        'vnc.connect': 'Connect',
        'vnc.securityFailure': 'Security handshake failed',
        'vnc.rotateHint': 'Landscape works better',
        'vnc.landscapeFullscreen': 'Rotate & fullscreen',
        'vnc.mobileKeyboard': 'Keyboard input',
        'vnc.mobileKeyboardPlaceholder': 'Type to send keys',
        'vnc.touchMode': 'Touch mode',
        'vnc.touchMode.trackpad': 'Screen mouse',
        'vnc.touchMode.touch': 'Touch screen',
        'vnc.viewOnly': 'View only',
        'vnc.sendCad': 'Send Ctrl+Alt+Del',
        'vnc.tuning': 'Display tuning',
        'vnc.showStats': 'Show stats',
        'vnc.minimize': 'Minimize',
        'vnc.fullscreen': 'Fullscreen',
        'vnc.windowed': 'Windowed',
        'vnc.fullView': 'Full view',
        'vnc.moreActions': 'More actions',
        'vnc.paste': 'Paste',
        'vnc.disconnect': 'Disconnect',
        'common.close': 'Close',
      }
      return map[key] || key
    },
  }),
}))

// matchMedia mock：mobileMatches 控 MOBILE_QUERY，portraitMatches 控 orientation
let mobileMatches = false
let portraitMatches = false

const renderView = (port = 5900) =>
  render(
    <DesktopView
      hostId="local"
      port={port}
      view="full"
      onViewChange={vi.fn()}
      onMinimize={vi.fn()}
      onClose={vi.fn()}
    />,
  )
const lastRfb = () => MockRFB.instances[MockRFB.instances.length - 1]
const emitCredentialsRequired = async (types = ['password']) => {
  await act(async () => {
    lastRfb().emit('credentialsrequired', { types })
  })
}

describe('DesktopView VNC password memory', () => {
  beforeEach(() => {
    MockRFB.instances = []
    getPasswordMock.mockReset().mockResolvedValue({})
    setPasswordMock.mockReset().mockResolvedValue({ success: true })
    deletePasswordMock.mockReset().mockResolvedValue({ success: true })
    displaysMock.mockReset().mockResolvedValue({ displays: [] })
    sendCredentialsMock.mockReset()
    sendKeyMock.mockReset()
    // mockClear 保留 handleMouseButton 的 _mouseButtonMask 同步实现（mockReset 会连实现一起清掉）
    handleMouseMoveMock.mockClear()
    handleMouseButtonMock.mockClear()
    cursorMoveMock.mockClear()
    mobileMatches = false
    portraitMatches = false
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width') ? mobileMatches : portraitMatches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    window.localStorage.clear()
    useConsoleStore.setState({ activeHostId: 'local', pushToast: vi.fn(), toasts: [] })
  })

  it('auto-answers credentialsrequired with a stored password without showing the form', async () => {
    getPasswordMock.mockResolvedValue({ password: 's3cret' })
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    expect(getPasswordMock).toHaveBeenCalledWith('local', 0)
    await emitCredentialsRequired()
    expect(sendCredentialsMock).toHaveBeenCalledWith({ username: undefined, password: 's3cret' })
    expect(screen.queryByPlaceholderText('Password')).toBeNull()
  })

  it('stores the password when remember is checked and clears it when unchecked', async () => {
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await emitCredentialsRequired()
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'typed-pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(sendCredentialsMock).toHaveBeenCalledWith({ username: undefined, password: 'typed-pw' })
    await waitFor(() => expect(deletePasswordMock).toHaveBeenCalledWith('local', 0))

    // securityfailure 回落表单后勾选记住：提交写 PUT
    await act(async () => {
      lastRfb().emit('securityfailure', { status: 1, reason: 'bad' })
    })
    await emitCredentialsRequired()
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'new-pw' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember password' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(setPasswordMock).toHaveBeenCalledWith('local', 0, 'new-pw'))
  })

  it('clears the stored password and falls back to the prefilled form after securityfailure', async () => {
    getPasswordMock.mockResolvedValue({ password: 'bad-pw' })
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await emitCredentialsRequired()
    expect(sendCredentialsMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      lastRfb().emit('securityfailure', { status: 1, reason: 'bad' })
    })
    expect(deletePasswordMock).toHaveBeenCalledWith('local', 0)
    // 回落表单且预填已存密码供手改
    await emitCredentialsRequired()
    const input = screen.getByPlaceholderText('Password') as HTMLInputElement
    expect(input.value).toBe('bad-pw')
    expect(sendCredentialsMock).toHaveBeenCalledTimes(1)
  })

  it('renders rss size for running displays and ~ for stopped ones in the picker', async () => {
    displaysMock.mockResolvedValue({
      displays: [{ display: 2, port: 5902, process: 'Xtigervnc', pid: 100, rssKB: 204800 }],
    })
    renderView(5902)
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    await waitFor(() => expect(displaysMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Displays' }))
    const picker = screen.getByRole('button', { name: 'Displays' }).parentElement!
    const rows = Array.from(picker.querySelectorAll('div.group'))
    const runningRow = rows.find((el) => el.textContent?.includes('Xtigervnc'))!
    expect(runningRow.textContent).toContain('200.0 MB')
    const stoppedRow = rows.find((el) => el.textContent === ':35903~')!
    expect(stoppedRow.textContent).toContain('~')
  })

  it('shows the rotate hint on mobile portrait and dismisses it', async () => {
    mobileMatches = true
    portraitMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    const hint = screen.getByText('Landscape works better').closest('div')!
    fireEvent.click(within(hint).getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Landscape works better')).toBeNull()
  })

  it('does not show the rotate hint on desktop layout', async () => {
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    expect(screen.queryByText('Landscape works better')).toBeNull()
  })

  it('sends printable chars and special keys through the mobile keyboard bar', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard input' }))
    const input = screen.getByPlaceholderText('Type to send keys')
    // 'a'=0x61 down+up，中文走 0x01000000|codePoint
    fireEvent.input(input, { inputType: 'insertText', data: 'a中' })
    expect(sendKeyMock).toHaveBeenCalledWith(0x61, '', true)
    expect(sendKeyMock).toHaveBeenCalledWith(0x61, '', false)
    expect(sendKeyMock).toHaveBeenCalledWith(0x01000000 | 0x4e2d, '', true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sendKeyMock).toHaveBeenCalledWith(0xff0d, 'Enter', true)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(sendKeyMock).toHaveBeenCalledWith(0xff1b, 'Escape', true)
    // input 常驻（收条后隐藏仍在 DOM）：特殊键行消失，焦点让回 canvas 恢复原生链路
    expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull()
    expect(document.activeElement).toBe(lastRfb().target.querySelector('canvas'))
  })

  it('keeps the keyboard button hidden on desktop layout', async () => {
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Keyboard input' })).toBeNull()
  })

  it('times out a stalled handshake and suggests other running displays', async () => {
    vi.useFakeTimers()
    try {
      displaysMock.mockResolvedValue({
        displays: [{ display: 9, port: 5909, process: 'Xtigervnc', pid: 1, rssKB: 1024 }],
      })
      renderView()
      await act(async () => {})
      await act(async () => {})
      expect(lastRfb()).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(16000)
      })
      expect(lastRfb().disconnect).toHaveBeenCalled()
      await act(async () => {})
      await act(async () => {})
      expect(screen.getByText('vnc.connectTimeout')).toBeTruthy()
      expect(displaysMock).toHaveBeenCalled()
      expect(screen.getByText('vnc.displayDetected')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the display picker with a hint after an unclean disconnect', async () => {
    displaysMock.mockResolvedValue({
      displays: [{ display: 9, port: 5909, process: 'Xtigervnc', pid: 1, rssKB: 1024 }],
    })
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    // suggestDisplays 的 fetch 解析是微任务，合并在同一 act 内冲刷避免状态更新落在 act 外
    await act(async () => {
      lastRfb().emit('disconnect', { clean: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('vnc.displayDetected')).toBeTruthy())
    expect(displaysMock).toHaveBeenCalled()
  })

  it('collapses low-frequency buttons into the overflow menu on mobile', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    // 低频按钮不在 header,窗口化移动端隐藏
    expect(screen.queryByRole('button', { name: 'View only' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Display tuning' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Minimize' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Windowed' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    // 菜单项 icon+label 行；点击执行原动作并关菜单
    expect(screen.getByText('View only')).toBeTruthy()
    expect(screen.getByText('Minimize')).toBeTruthy()
    fireEvent.click(screen.getByText('View only'))
    expect(screen.queryByText('View only')).toBeNull()
  })

  it('keeps every toolbar button inline on desktop and toggles windowed view', async () => {
    const onViewChange = vi.fn()
    render(
      <DesktopView
        hostId="local"
        port={5900}
        view="full"
        onViewChange={onViewChange}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    expect(screen.getByRole('button', { name: 'View only' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Display tuning' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Windowed' }))
    expect(onViewChange).toHaveBeenCalledWith('window')
  })

  it('requests real browser fullscreen on the root section instead of switching view', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    const exitFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen })
    const onViewChange = vi.fn()
    try {
      render(
        <DesktopView
          hostId="local"
          port={5900}
          view="full"
          onViewChange={onViewChange}
          onMinimize={vi.fn()}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() => expect(lastRfb()).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
      expect(requestFullscreen).toHaveBeenCalledTimes(1)
      // 语义是浏览器全屏,不再是 app 内铺满切换
      expect(onViewChange).not.toHaveBeenCalled()
    } finally {
      delete (window.HTMLElement.prototype as any).requestFullscreen
      delete (document as any).exitFullscreen
    }
  })

  it('does not suggest displays when the attempted display itself is running', async () => {
    displaysMock.mockResolvedValue({
      displays: [{ display: 0, port: 5900, process: 'Xtigervnc', pid: 1 }],
    })
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('disconnect', { clean: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(displaysMock).toHaveBeenCalled())
    expect(screen.queryByText('vnc.displayDetected')).toBeNull()
  })

  it('toggles the touch mode on mobile and persists the selection', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const toggle = screen.getByRole('button', { name: /Touch mode/ })
    expect(toggle.getAttribute('aria-label')).toBe('Touch mode: Screen mouse')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Touch mode/ }).getAttribute('aria-label')).toBe(
      'Touch mode: Touch screen',
    )
    expect(window.localStorage.getItem('tmuxgo:vnc-touch-mode')).toBe('touch')
  })

  it('hides the touch-mode toggle on desktop layout', async () => {
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Touch mode/ })).toBeNull()
  })

  // jsdom 无真实触摸事件：构造 Event 后挂 touches，经 capture 进适配层
  const canvasRect = {
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
  const fireTouch = (
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    touches: Array<{ identifier: number; clientX: number; clientY: number }>,
  ) => {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'touches', { value: touches })
    fireEvent(lastRfb().target.querySelector('canvas')!, ev)
  }

  it('sends a left click at the virtual cursor on tap in trackpad mode', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      lastRfb()._mousePos = { x: 120, y: 90 }
      fireTouch('touchstart', [{ identifier: 0, clientX: 300, clientY: 200 }])
      fireTouch('touchend', [])
      // 屏幕鼠标模式触点无关：点击落在虚拟光标（_mousePos 种子）处
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(1, 120, 90, 1)
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(2, 120, 90, 0)
      expect(cursorMoveMock).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('sends a right click on two-finger tap and wheel steps on two-finger scroll', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      const t0 = { identifier: 0, clientX: 200, clientY: 150 }
      const t1 = { identifier: 1, clientX: 240, clientY: 170 }
      fireTouch('touchstart', [t0])
      fireTouch('touchstart', [t0, t1])
      // 两指必须在同一个 touchend 里一起抬起才构成双指短按
      fireTouch('touchend', [])
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(1, 0, 0, 4)
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(2, 0, 0, 0)
      handleMouseButtonMock.mockClear()
      // 双指下移 60px 质心 → 一步滚轮上（拖内容约定）
      fireTouch('touchstart', [t0])
      fireTouch('touchstart', [t0, t1])
      fireTouch('touchmove', [
        { identifier: 0, clientX: 200, clientY: 210 },
        { identifier: 1, clientX: 240, clientY: 230 },
      ])
      expect(handleMouseButtonMock).toHaveBeenCalledWith(0, 0, 8)
      expect(handleMouseButtonMock).toHaveBeenCalledWith(0, 0, 0)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not right-click when two fingers lift one at a time', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      const t0 = { identifier: 0, clientX: 200, clientY: 150 }
      const t1 = { identifier: 1, clientX: 240, clientY: 170 }
      fireTouch('touchstart', [t0])
      fireTouch('touchstart', [t0, t1])
      fireTouch('touchend', [t1])
      fireTouch('touchend', [])
      expect(handleMouseButtonMock).not.toHaveBeenCalled()
      expect(handleMouseMoveMock).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('sends no pointer events at all in view-only mode on mobile', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      // 先验通：正常模式下单指 tap 有输出
      fireTouch('touchstart', [{ identifier: 0, clientX: 100, clientY: 100 }])
      fireTouch('touchend', [])
      expect(handleMouseButtonMock).toHaveBeenCalled()
      handleMouseButtonMock.mockClear()
      handleMouseMoveMock.mockClear()
      // 开 view-only 后适配器不接管：任何触点都不产生 pointer 事件
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
      fireEvent.click(screen.getByText('View only'))
      fireTouch('touchstart', [{ identifier: 0, clientX: 100, clientY: 100 }])
      fireTouch('touchmove', [{ identifier: 0, clientX: 160, clientY: 140 }])
      fireTouch('touchend', [])
      fireTouch('touchstart', [{ identifier: 0, clientX: 200, clientY: 150 }])
      fireTouch('touchstart', [
        { identifier: 0, clientX: 200, clientY: 150 },
        { identifier: 1, clientX: 240, clientY: 170 },
      ])
      fireTouch('touchend', [])
      expect(handleMouseButtonMock).not.toHaveBeenCalled()
      expect(handleMouseMoveMock).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps canvas, pointer indicator and keyboard input inside the fullscreen subtree', async () => {
    mobileMatches = true
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    try {
      renderView()
      await waitFor(() => expect(lastRfb()).toBeTruthy())
      await act(async () => {
        lastRfb().emit('connect', {})
      })
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
      // 全屏元素必须是 section 根：canvas/指示器/键盘输入/header 按钮都在其子树内才不被裁
      const fullscreenEl = requestFullscreen.mock.contexts[0] as HTMLElement
      expect(fullscreenEl).toBeTruthy()
      expect(fullscreenEl.contains(lastRfb().target.querySelector('canvas'))).toBe(true)
      expect(fullscreenEl.contains(document.querySelector('[data-vnc-pointer]'))).toBe(true)
      expect(fullscreenEl.contains(screen.getByPlaceholderText('Type to send keys'))).toBe(true)
      expect(fullscreenEl.contains(screen.getByRole('button', { name: 'Keyboard input' }))).toBe(true)
    } finally {
      delete (window.HTMLElement.prototype as any).requestFullscreen
    }
  })

  it('does not focus the keyboard input on a plain canvas tap (canvas keeps keys)', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    const input = screen.getByPlaceholderText('Type to send keys')
    const canvas = lastRfb().target.querySelector('canvas')!
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      // 普通 tap：input 不得聚焦（否则每次点击都弹系统键盘），焦点回 canvas 走 noVNC 原生链路
      fireTouch('touchstart', [{ identifier: 0, clientX: 100, clientY: 100 }])
      fireTouch('touchend', [])
      expect(document.activeElement).not.toBe(input)
      expect(document.activeElement).toBe(canvas)
      expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps input focus and single-send on canvas tap while the bar is open', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard input' }))
    const input = screen.getByPlaceholderText('Type to send keys')
    await waitFor(() => expect(document.activeElement).toBe(input))
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      // 开条状态点画布：适配层拦截 touch，canvas 不会抢走 input 焦点
      fireTouch('touchstart', [{ identifier: 0, clientX: 100, clientY: 100 }])
      fireTouch('touchend', [])
      expect(document.activeElement).toBe(input)
      // Enter 只经 input keydown 一条路发出：down+up 各一次，无重复
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(sendKeyMock.mock.calls.filter((c) => c[0] === 0xff0d)).toEqual([
        [0xff0d, 'Enter', true],
        [0xff0d, 'Enter', false],
      ])
      // canvas 的 keydown 只属于 noVNC 原生 Keyboard（mock 无处理器），组件不重复发
      fireEvent.keyDown(lastRfb().target.querySelector('canvas')!, { key: 'a' })
      expect(sendKeyMock.mock.calls.filter((c) => c[0] === 0x61)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('sends IME composition only once on commit, ignoring prefix updates', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard input' }))
    const input = screen.getByPlaceholderText('Type to send keys')
    // Android/中文输入法典型序列：compositionstart + 前缀 insertCompositionText 更新 + end 提交
    fireEvent.compositionStart(input)
    for (const p of ['c', 'cl', 'cle', 'clea', 'clear']) {
      fireEvent.input(input, { inputType: 'insertCompositionText', data: p, isComposing: true })
    }
    fireEvent.compositionEnd(input, { data: 'clear' })
    // 部分浏览器 commit 后补一个同内容 input 事件：去重不得再发
    fireEvent.input(input, { inputType: 'insertText', data: 'clear' })
    const downs = sendKeyMock.mock.calls.filter((c) => c[2] === true).map((c) => c[0])
    expect(downs).toEqual([0x63, 0x6c, 0x65, 0x61, 0x72])
  })

  it('sends only the delta for prefix insertCompositionText without composition events', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard input' }))
    const input = screen.getByPlaceholderText('Type to send keys')
    // 无 composition 事件的怪癖软键盘：每击键发整段前缀，只能按差量补发尾部
    for (const p of ['c', 'cl', 'cle', 'clea', 'clear']) {
      fireEvent.input(input, { inputType: 'insertCompositionText', data: p })
    }
    const downs = sendKeyMock.mock.calls.filter((c) => c[2] === true).map((c) => c[0])
    expect(downs).toEqual([0x63, 0x6c, 0x65, 0x61, 0x72])
  })

  it('positions an in-subtree pointer indicator after touch movement in trackpad mode', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      // 未连接/未触摸时指示器不渲染
      expect(document.querySelector('[data-vnc-pointer]')).toBeNull()
      await act(async () => {
        lastRfb().emit('connect', {})
      })
      fireTouch('touchstart', [{ identifier: 0, clientX: 100, clientY: 100 }])
      fireTouch('touchmove', [{ identifier: 0, clientX: 130, clientY: 140 }])
      const indicator = document.querySelector('[data-vnc-pointer]') as HTMLElement
      expect(indicator).toBeTruthy()
      // 挂点在 VNC 容器同级子树（fullscreen 覆盖范围内），不是 document.body
      expect(indicator.parentElement).toBe(lastRfb().target.parentElement)
      // 虚拟光标 (0,0)+delta(30,40)，client 与容器原点同为 0 → 相对坐标 (30,40)
      expect(indicator.style.opacity).toBe('1')
      expect(indicator.style.transform).toContain('translate(30px, 40px)')
      expect(indicator.className).toContain('pointer-events-none')
    } finally {
      spy.mockRestore()
    }
  })

  it('maps touch points to absolute coordinates after switching to touch mode', async () => {
    mobileMatches = true
    window.localStorage.setItem('tmuxgo:vnc-touch-mode', 'touch')
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect)
    try {
      fireTouch('touchstart', [{ identifier: 0, clientX: 150, clientY: 120 }])
      // 触摸模式落下即悬停到触点
      expect(handleMouseMoveMock).toHaveBeenCalledWith(150, 120)
      fireTouch('touchend', [])
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(1, 150, 120, 1)
      expect(handleMouseButtonMock).toHaveBeenNthCalledWith(2, 150, 120, 0)
    } finally {
      spy.mockRestore()
    }
  })

  it('sends special keys and releases latched modifiers from the mobile keyboard bar', async () => {
    mobileMatches = true
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    await act(async () => {
      lastRfb().emit('connect', {})
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard input' }))
    // 修饰键锁存：按下不立即抬起，普通按键趁按住期间发出完成组合
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }))
    expect(sendKeyMock).toHaveBeenCalledWith(0xffe3, 'ControlLeft', true)
    expect(sendKeyMock).not.toHaveBeenCalledWith(0xffe3, 'ControlLeft', false)
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }))
    expect(sendKeyMock).toHaveBeenCalledWith(0xff1b, 'Escape', true)
    expect(sendKeyMock).toHaveBeenCalledWith(0xff1b, 'Escape', false)
    fireEvent.click(screen.getByRole('button', { name: 'ArrowUp' }))
    expect(sendKeyMock).toHaveBeenCalledWith(0xff52, 'ArrowUp', true)
    // 收条时锁存的 Ctrl 必须抬起，避免远端修饰键卡死
    const bar = screen.getByPlaceholderText('Type to send keys').parentElement!.parentElement!
    fireEvent.click(within(bar).getByRole('button', { name: 'Close' }))
    expect(sendKeyMock).toHaveBeenCalledWith(0xffe3, 'ControlLeft', false)
  })
})
