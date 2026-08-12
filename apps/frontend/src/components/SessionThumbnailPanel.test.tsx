import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionThumbnailPanel } from './SessionThumbnailPanel'

const setThumbnailPanelOpen = vi.fn()
const refetch = vi.fn()
const { createSplitGroupMock } = vi.hoisted(() => ({ createSplitGroupMock: vi.fn() }))

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
  useConsoleStore: (selector: any) => selector({ activeHostId: 'local', activeSessionId: 'local:alpha', setThumbnailPanelOpen, openSplitGroup: vi.fn(), pushToast: vi.fn() }),
}))
vi.mock('@/hooks/useSplitGroups', () => ({
  useSplitGroups: () => ({ groups: [], create: createSplitGroupMock, update: vi.fn(), remove: vi.fn() }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./PaneGrid', () => ({
  PaneGrid: ({ sessionId }: { sessionId: string }) => React.createElement('div', { 'data-testid': 'interactive-terminal' }, sessionId),
}))

describe('SessionThumbnailPanel', () => {
  const originalElementFromPoint = document.elementFromPoint
  beforeEach(() => {
    setThumbnailPanelOpen.mockReset()
    refetch.mockReset()
    createSplitGroupMock.mockReset()
    vi.useFakeTimers()
    document.elementFromPoint = () => null
  })
  afterEach(() => {
    vi.useRealTimers()
    document.elementFromPoint = originalElementFromPoint
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

  it('creates a split group by long-press dragging one thumbnail onto another', () => {
    render(<SessionThumbnailPanel />)
    const beta = screen.getByTitle('beta')
    const alphaCard = screen.getByTestId('thumbnail-selected-card')
    document.elementFromPoint = () => alphaCard as unknown as Element
    beta.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    alphaCard.getBoundingClientRect = () => ({ left: 300, top: 0, width: 200, height: 100, right: 500, bottom: 100, x: 300, y: 0, toJSON: () => ({}) }) as DOMRect
    fireEvent.pointerDown(beta, { pointerId: 1, clientX: 10, clientY: 10, pointerType: 'mouse', button: 0 })
    vi.advanceTimersByTime(600)
    fireEvent.pointerMove(beta, { pointerId: 1, clientX: 400, clientY: 50 })
    fireEvent.pointerUp(beta, { pointerId: 1 })
    expect(createSplitGroupMock).toHaveBeenCalledWith(expect.objectContaining({ primarySessionId: 'local:beta', secondarySessionId: 'local:alpha', direction: 'horizontal', hostId: 'local' }))
  })
})
