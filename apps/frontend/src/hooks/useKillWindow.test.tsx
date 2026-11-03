import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useKillWindow } from './useApi'

const killMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { windows: { kill: killMock } } }))

const HOST = 'local'
const SESSION = 'session-dev'

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  queryClient.setQueryData(
    ['sessions', HOST],
    [
      { id: SESSION, name: 'dev' },
      { id: 'session-other', name: 'other' },
    ],
  )
  queryClient.setQueryData(['windows', HOST, SESSION], [{ id: 'local:@1' }])
  queryClient.setQueryData(['session-snapshot', HOST, SESSION], { sessionId: SESSION, panes: [] })
  queryClient.setQueryData(['session-panes', HOST, SESSION], [{ id: 'local:%1' }])
  const { result } = renderHook(() => useKillWindow(), { wrapper })
  return { queryClient, result }
}

describe('useKillWindow', () => {
  it('drops the session and its structure queries when the last window takes the session down', async () => {
    killMock.mockResolvedValue({ ok: true, sessionGone: true, windows: [] })
    const { queryClient, result } = setup()

    await act(async () => {
      await result.current.mutateAsync({ hostId: HOST, sessionId: SESSION, windowId: 'local:@1' })
    })

    // 会话从列表里摘掉：ConsoleLayout 的 sessions 对账据此把 active 切走/落到空态
    expect(queryClient.getQueryData(['sessions', HOST])).toEqual([{ id: 'session-other', name: 'other' }])
    // 指向已销毁会话的查询不留在缓存里，避免继续按旧 key 打 404
    expect(queryClient.getQueryData(['windows', HOST, SESSION])).toBeUndefined()
    expect(queryClient.getQueryData(['session-snapshot', HOST, SESSION])).toBeUndefined()
    expect(queryClient.getQueryData(['session-panes', HOST, SESSION])).toBeUndefined()
  })

  it('keeps caching the window list when the session survives a normal kill', async () => {
    const remaining = [{ id: 'local:@2', sessionId: SESSION, index: 0, name: 'logs', active: true }]
    killMock.mockResolvedValue({ ok: true, windows: remaining })
    const { queryClient, result } = setup()

    await act(async () => {
      await result.current.mutateAsync({ hostId: HOST, sessionId: SESSION, windowId: 'local:@1' })
    })

    expect(queryClient.getQueryData(['windows', HOST, SESSION])).toEqual(remaining)
    expect(queryClient.getQueryData(['sessions', HOST])).toHaveLength(2)
    expect(queryClient.getQueryState(['session-snapshot', HOST, SESSION])?.isInvalidated).toBe(true)
  })
})
