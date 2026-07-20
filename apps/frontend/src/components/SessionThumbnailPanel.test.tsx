import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionThumbnailPanel } from './SessionThumbnailPanel'

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
  useConsoleStore: (selector: any) => selector({ activeHostId: 'local', activeSessionId: 'local:alpha', setThumbnailPanelOpen }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./PaneGrid', () => ({
  PaneGrid: ({ sessionId }: { sessionId: string }) => React.createElement('div', { 'data-testid': 'interactive-terminal' }, sessionId),
}))

describe('SessionThumbnailPanel', () => {
  beforeEach(() => {
    setThumbnailPanelOpen.mockReset()
    refetch.mockReset()
  })

  it('keeps selection in the thumbnail workspace', () => {
    render(<SessionThumbnailPanel />)
    expect(screen.getByTestId('interactive-terminal')).toHaveTextContent('local:alpha')
    fireEvent.click(screen.getByTitle('beta'))
    expect(screen.getByTestId('interactive-terminal')).toHaveTextContent('local:beta')
    expect(setThumbnailPanelOpen).not.toHaveBeenCalled()
  })

  it('refreshes thumbnails from the toolbar', () => {
    render(<SessionThumbnailPanel />)
    fireEvent.click(screen.getByTitle('thumbnail.refresh'))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
