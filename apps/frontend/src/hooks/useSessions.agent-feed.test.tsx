import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessions } from './useApi'
import { resetAgentFeedFreshness, AgentFeedClient } from '@/lib/agent-feed'
import type { AgentPaneState, Session } from '@/types'

const apiMocks = vi.hoisted(() => ({ sessionsList: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { sessions: { list: apiMocks.sessionsList } },
}))

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id: `session-local-${id}`,
    hostId: 'local',
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    windowCount: 1,
    ...extra,
  }
}

function agentPane(paneId: string): AgentPaneState {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName: 'dev',
    agent: 'codex',
    agentStatus: 'blocked',
    revision: 7,
  }
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
}

// 推送健康时 REST 该少带 agents、且不能冲掉推送已写入的 agent 字段；
// 推送不健康时必须原样使用 REST 的 agents，否则界面会丢状态
describe('useSessions + agent 推送协同', () => {
  beforeEach(() => {
    apiMocks.sessionsList.mockReset()
    resetAgentFeedFreshness()
  })

  it('requests agents from REST when no push subscription is active', async () => {
    apiMocks.sessionsList.mockResolvedValue([session('dev', { agents: [agentPane('local:%1')] })])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const { result } = renderHook(() => useSessions('local'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiMocks.sessionsList).toHaveBeenCalledWith('local', { includeAgents: true })
    expect(result.current.data?.[0].agents?.map((pane) => pane.agentStatus)).toEqual(['blocked'])
  })

  it('skips agents over REST and keeps the pushed state in the cache', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    // 第一轮：还没有推送订阅，REST 带 agents
    apiMocks.sessionsList.mockResolvedValue([
      session('dev', { agents: [{ ...agentPane('local:%1'), agentStatus: 'working' }] }),
    ])
    const { result } = renderHook(() => useSessions('local'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiMocks.sessionsList).toHaveBeenLastCalledWith('local', { includeAgents: true })

    // 订阅推送后，推送把 blocked 写进缓存（PaneNotifications 干的事）
    const feed = new AgentFeedClient({ send: () => true, onUpdate: () => {}, onDegraded: () => {} })
    feed.subscribe('local')
    client.setQueryData<Session[]>(
      ['sessions', 'local'],
      [session('dev', { agents: [agentPane('local:%1')], agentSummary: undefined })],
    )
    // 第二轮：REST 只回结构字段
    apiMocks.sessionsList.mockResolvedValue([session('dev')])
    await client.invalidateQueries({ queryKey: ['sessions', 'local'] })
    await waitFor(() => expect(apiMocks.sessionsList).toHaveBeenLastCalledWith('local', { includeAgents: false }))
    // 断言的载体是 query 缓存本身（UI 通过 useQuery 读的就是它）：REST 没带 agents，
    // 但推送写的 blocked 必须还在，否则徽标会闪没
    await waitFor(() =>
      expect((client.getQueryData(['sessions', 'local']) as Session[] | undefined)?.[0]?.agents?.[0]?.agentStatus).toBe(
        'blocked',
      ),
    )
  })

  it('drops carried agent fields for sessions that disappear and keeps new ones intact', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    client.setQueryData<Session[]>(
      ['sessions', 'local'],
      [session('dev', { agents: [agentPane('local:%1')] }), session('old', { agents: [agentPane('local:%9')] })],
    )
    const feed = new AgentFeedClient({ send: () => true, onUpdate: () => {}, onDegraded: () => {} })
    feed.subscribe('local')
    apiMocks.sessionsList.mockResolvedValue([session('dev'), session('fresh')])
    const { result } = renderHook(() => useSessions('local'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    client.invalidateQueries({ queryKey: ['sessions', 'local'] })
    await waitFor(() => expect(result.current.data?.map((item) => item.name)).toEqual(['dev', 'fresh']))
    const byName = new Map(result.current.data?.map((item) => [item.name, item]))
    expect(byName.get('dev')?.agents?.[0].paneId).toBe('local:%1')
    expect(byName.get('fresh')?.agents).toBeUndefined()
  })
})
