import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { AGENT_SEEN_DWELL_MS, useAgentSeen } from './useAgentSeen'
import type { Pane } from '@/types'

const sendMock = vi.fn(() => true)
vi.mock('./useWebSocket', () => ({
  useWebSocket: () => ({ send: sendMock, isSocketReady: true }),
}))
const snapshotRef: { current: { panes: Pane[] } | undefined } = { current: undefined }
vi.mock('./useApi', () => ({
  useSessionSnapshot: () => ({ data: snapshotRef.current }),
}))

function setActivePane(status: Pane['agentStatus'], eventId = 'ev-1') {
  snapshotRef.current = {
    panes: [
      {
        id: 'local:%1',
        windowId: 'local:@1',
        index: 0,
        title: 'agent',
        active: true,
        size: { cols: 80, rows: 24 },
        agent: 'codex',
        agentStatus: status,
        revision: 3,
        stateSeq: 9,
        eventId,
      } as Pane,
    ],
  }
  useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'local:dev', activePaneId: 'local:%1' })
}

describe('useAgentSeen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendMock.mockClear()
    setActivePane('done')
  })
  afterEach(() => {
    vi.useRealTimers()
    snapshotRef.current = undefined
  })

  it('acks a done pane only after the dwell window', () => {
    renderHook(() => useAgentSeen())
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS - 1)
    })
    expect(sendMock).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sendMock).toHaveBeenCalledWith({ type: 'agent_seen', paneId: 'local:%1' })
  })

  it('restarts the dwell when the pane leaves done before it elapses', () => {
    const { rerender } = renderHook(() => useAgentSeen())
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS - 100)
      setActivePane('working')
    })
    rerender()
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS)
    })
    expect(sendMock).not.toHaveBeenCalled()
    act(() => {
      setActivePane('done', 'ev-2')
    })
    rerender()
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS)
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('does not re-ack the same done event on rerender', () => {
    const { rerender } = renderHook(() => useAgentSeen())
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS)
    })
    rerender()
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS * 2)
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('skips the ack while the page is hidden', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useAgentSeen())
    act(() => {
      vi.advanceTimersByTime(AGENT_SEEN_DWELL_MS * 2)
    })
    expect(sendMock).not.toHaveBeenCalled()
    visibility.mockRestore()
  })
})
