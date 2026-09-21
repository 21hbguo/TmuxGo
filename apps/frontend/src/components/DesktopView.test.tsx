import React, { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopView } from './DesktopView'
import { useConsoleStore } from '@/stores/useConsoleStore'

const { getPasswordMock, setPasswordMock, deletePasswordMock, displaysMock, sendCredentialsMock, MockRFB } = vi.hoisted(
  () => {
    const sendCredentials = vi.fn()
    class RFB {
      static instances: RFB[] = []
      handlers = new Map<string, ((event: { detail: any }) => void)[]>()
      sendCredentials = sendCredentials
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
      MockRFB: RFB,
    }
  },
)

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
      }
      return map[key] || key
    },
  }),
}))

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
})
