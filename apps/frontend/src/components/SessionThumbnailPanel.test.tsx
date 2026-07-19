import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionThumbnailPanel } from './SessionThumbnailPanel'

const setActiveSession = vi.fn()
const setSessionPanelExpanded = vi.fn()
const setThumbnailPanelOpen = vi.fn()
const refetch = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useSessionThumbnails: () => ({
    data: { sessions: [
      { id: 'local:alpha', name: 'alpha', window: { id: 'local:@1', index: 0, name: 'shell', zoomed: false }, panes: [{ id: 'local:%1', title: 'shell', active: true, left: 0, top: 0, size: { cols: 80, rows: 24 }, data: 'alpha output' }] },
      { id: 'local:beta', name: 'beta', window: { id: 'local:@2', index: 0, name: 'logs', zoomed: false }, panes: [{ id: 'local:%2', title: 'logs', active: true, left: 0, top: 0, size: { cols: 80, rows: 24 }, data: 'beta output' }] },
    ] },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch,
  }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [{ id: 'local:beta' }, { id: 'local:alpha' }] }),
}))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector({ activeHostId: 'local', activeSessionId: 'local:alpha', setActiveSession, setSessionPanelExpanded, setThumbnailPanelOpen }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('SessionThumbnailPanel', () => {
  beforeEach(() => {
    setActiveSession.mockReset()
    setSessionPanelExpanded.mockReset()
    setThumbnailPanelOpen.mockReset()
    refetch.mockReset()
  })

  it('orders cards by the session list and returns to sessions after selection', () => {
    render(<SessionThumbnailPanel />)
    expect(screen.getAllByTitle(/alpha|beta/).map((item) => item.getAttribute('title'))).toEqual(['beta', 'alpha'])
    fireEvent.click(screen.getByTitle('beta'))
    expect(setActiveSession).toHaveBeenCalledWith('local:beta')
    expect(setThumbnailPanelOpen).toHaveBeenCalledWith(false)
    expect(setSessionPanelExpanded).toHaveBeenCalledWith(true)
  })

  it('refreshes thumbnails from the toolbar', () => {
    render(<SessionThumbnailPanel />)
    fireEvent.click(screen.getByTitle('thumbnail.refresh'))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
