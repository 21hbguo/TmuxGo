import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useSessionSnapshotSync } from './useSessionSnapshotSync'

const snapshotGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { snapshot: { get: snapshotGet } } }))

function renderSync() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const rendered = renderHook(() => useSessionSnapshotSync(), { wrapper })
  return { queryClient, ...rendered }
}

describe('useSessionSnapshotSync', () => {
  beforeEach(() => {
    snapshotGet.mockReset()
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev' })
  })

  it('invalidates structure queries so pane lists refresh after split', async () => {
    snapshotGet.mockResolvedValue({
      sessionId: 'local:session-dev',
      windows: [{ id: 'local:@1', active: true }],
      panes: [
        { id: 'local:%1', windowId: 'local:@1', active: true },
        { id: 'local:%2', windowId: 'local:@1', active: false },
      ],
      activeWindowId: 'local:@1',
      activePaneId: 'local:%2',
    })
    const { queryClient, result } = renderSync()
    queryClient.setQueryData(['windows', 'local', 'session-dev'], [{ id: 'local:@1' }])
    queryClient.setQueryData(['session-panes', 'local', 'session-dev'], [{ id: 'local:%1' }])
    queryClient.setQueryData(['panes', 'local:@1'], [{ id: 'local:%1' }])
    await act(async () => {
      await result.current.refreshSnapshot()
    })
    expect(queryClient.getQueryState(['windows', 'local', 'session-dev'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['session-panes', 'local', 'session-dev'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['panes', 'local:@1'])?.isInvalidated).toBe(true)
    expect(
      queryClient.getQueryData<{ panes?: unknown[] }>(['session-snapshot', 'local', 'session-dev'])?.panes?.length,
    ).toBe(2)
    expect(useConsoleStore.getState().activePaneId).toBe('local:%2')
  })

  it('does nothing when no host/session is active', async () => {
    useConsoleStore.setState({ activeHostId: null, activeSessionId: null })
    const { result } = renderSync()
    await act(async () => {
      expect(await result.current.refreshSnapshot()).toBeNull()
    })
    expect(snapshotGet).not.toHaveBeenCalled()
  })
})
