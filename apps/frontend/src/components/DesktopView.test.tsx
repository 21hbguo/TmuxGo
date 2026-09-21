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
  MockRFB,
} = vi.hoisted(() => {
  const sendCredentials = vi.fn()
  const sendKey = vi.fn()
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
    constructor(
      public target: HTMLElement,
      public url: string,
      public options: unknown,
    ) {
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
    expect(screen.queryByPlaceholderText('Type to send keys')).toBeNull()
  })

  it('keeps the keyboard button hidden on desktop layout', async () => {
    renderView()
    await waitFor(() => expect(lastRfb()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Keyboard input' })).toBeNull()
  })
})
