import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionChangeFeed } from './useSessionChangeFeed'
import { resetSessionChangeFeedsForTests, SESSION_CHANGE_WAIT_MS } from '@/lib/session-change-feed'

type PendingCall = {
  hostId: string
  since: number | null
  waitMs: number
  signal?: AbortSignal
  resolve: (value: { revision: number; changed: boolean }) => void
  reject: (error: unknown) => void
}

const apiMocks = vi.hoisted(() => ({ changes: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { sessions: { changes: apiMocks.changes } },
}))

function hookHost(hostId: string, enabled = true) {
  function Consumer() {
    useSessionChangeFeed(hostId, enabled)
    return null
  }
  return Consumer
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
}

// 长轮询是「会话区秒级刷新」的主通道：这里锁住它的三条行为契约——
// 首帧只对齐版本号、版本变化才 invalidate、同一 host 多观察者共用一条请求
describe('useSessionChangeFeed', () => {
  let pending: PendingCall[] = []
  beforeEach(() => {
    apiMocks.changes.mockReset()
    pending = []
    apiMocks.changes.mockImplementation(
      (hostId: string, since: number | null, waitMs: number, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          pending.push({ hostId, since, waitMs, signal, resolve, reject })
        }),
    )
    resetSessionChangeFeedsForTests()
  })
  afterEach(() => {
    resetSessionChangeFeedsForTests()
  })

  it('aligns the first frame without invalidating, then invalidates on a real change', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(React.createElement(hookHost('local')), { wrapper: wrapper(client) })

    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0]).toMatchObject({ hostId: 'local', since: null, waitMs: SESSION_CHANGE_WAIT_MS })
    // 首帧：客户端刚用 REST 取到列表，版本号只是对齐用，不该再触发一次全量拉取
    pending[0].resolve({ revision: 7, changed: false })
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].since).toBe(7)
    expect(invalidate).not.toHaveBeenCalled()

    pending[1].resolve({ revision: 8, changed: true })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'local'] }))
    await waitFor(() => expect(pending).toHaveLength(3))
    expect(pending[2].since).toBe(8)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('shares one long poll between every observer of the same host', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const Consumer = hookHost('local')
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Consumer),
        React.createElement(Consumer),
        React.createElement(Consumer),
      ),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(pending).toHaveLength(1))
    // 给重复订阅留出足够时间：多挂两条会立刻出现在 pending 里
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pending).toHaveLength(1)
  })

  it('aborts the in-flight request when the last observer unmounts', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const view = render(React.createElement(hookHost('local')), { wrapper: wrapper(client) })
    await waitFor(() => expect(pending).toHaveLength(1))
    const signal = pending[0].signal
    expect(signal?.aborted).toBe(false)
    view.unmount()
    await waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('stops retrying when the gateway does not expose the endpoint', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(React.createElement(hookHost('local')), { wrapper: wrapper(client) })
    await waitFor(() => expect(pending).toHaveLength(1))
    pending[0].reject(Object.assign(new Error('Not Found'), { status: 404 }))
    // 老网关（或拦掉该路径的中间层）：静默退回 15s 兜底轮询，不再打这个端点
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pending).toHaveLength(1)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does not subscribe while the session list is placeholder data', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(React.createElement(hookHost('local', false)), { wrapper: wrapper(client) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pending).toHaveLength(0)
    expect(apiMocks.changes).not.toHaveBeenCalled()
  })
})
