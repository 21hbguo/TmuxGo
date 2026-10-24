import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DOCUMENT_TITLE } from '@/lib/document-title'
import { useDocumentTitle } from './useDocumentTitle'

// store / api 都是外部数据源：这里只验证「取到数据 → 写到 document.title」的映射与生命周期
const storeMock = vi.hoisted(() => ({
  activeHostId: 'local' as string | null,
  activeSessionId: 'session-local-api' as string | null,
}))
const apiMock = vi.hoisted(() => ({
  useHosts: vi.fn(),
  useSessionSnapshot: vi.fn(),
}))

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: (state: typeof storeMock) => unknown) => selector(storeMock),
}))
vi.mock('@/hooks/useApi', () => apiMock)

const Probe = () => {
  useDocumentTitle()
  return null
}

function attachedSnapshot(windowName = 'logs', sessionName = 'api') {
  return {
    data: {
      sessionName,
      activeWindowId: 'w2',
      windows: [
        { id: 'w1', sessionId: 'session-local-api', index: 0, name: 'shell', active: false },
        { id: 'w2', sessionId: 'session-local-api', index: 1, name: windowName, active: true },
      ],
    },
  }
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    storeMock.activeHostId = 'local'
    storeMock.activeSessionId = 'session-local-api'
    apiMock.useHosts.mockReturnValue({
      data: [
        { id: 'local', name: 'Local' },
        { id: 'devbox', name: 'devbox' },
      ],
    })
    apiMock.useSessionSnapshot.mockReturnValue(attachedSnapshot())
    document.title = DEFAULT_DOCUMENT_TITLE
  })
  afterEach(() => {
    document.title = DEFAULT_DOCUMENT_TITLE
  })

  it('titles the tab with host, session and the focused window', () => {
    const view = render(<Probe />)
    expect(document.title).toBe('Local - api: logs')
    view.unmount()
  })

  it('follows a window switch and drops the window segment when it has no name', () => {
    const view = render(<Probe />)
    expect(document.title).toBe('Local - api: logs')
    apiMock.useSessionSnapshot.mockReturnValue(attachedSnapshot('build'))
    view.rerender(<Probe />)
    expect(document.title).toBe('Local - api: build')
    apiMock.useSessionSnapshot.mockReturnValue(attachedSnapshot(''))
    view.rerender(<Probe />)
    expect(document.title).toBe('Local - api')
    view.unmount()
  })

  it('falls back to the default title without an attached session', () => {
    storeMock.activeSessionId = null
    apiMock.useSessionSnapshot.mockReturnValue({ data: undefined })
    const view = render(<Probe />)
    expect(document.title).toBe(DEFAULT_DOCUMENT_TITLE)
    view.unmount()
  })

  it('restores the default title on unmount instead of leaving a stale label', () => {
    const view = render(<Probe />)
    expect(document.title).toBe('Local - api: logs')
    view.unmount()
    expect(document.title).toBe(DEFAULT_DOCUMENT_TITLE)
  })

  it('uses the host id when the host list has not resolved yet', () => {
    storeMock.activeHostId = 'devbox'
    apiMock.useHosts.mockReturnValue({ data: undefined })
    const view = render(<Probe />)
    expect(document.title).toBe('devbox - api: logs')
    view.unmount()
  })
})
