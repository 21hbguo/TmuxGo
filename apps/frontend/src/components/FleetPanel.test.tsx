import React from 'react'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { FleetPanel } from './FleetPanel'
import { useFleetAlign, useFleetData } from '@/hooks/useFleet'
import { countFleetFromCache } from '@/hooks/useFleetCounts'
import type { AgentPaneState, AgentRecoveryCandidate, Host, Session } from '@/types'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  listBySession: vi.fn(),
  recoveryList: vi.fn(),
}))
const streamMocks = vi.hoisted(() => ({ listeners: new Set<(detail: unknown) => void>() }))
const navigateMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    hosts: { list: vi.fn(async () => []) },
    sessions: { list: apiMocks.list },
    panes: { listBySession: apiMocks.listBySession },
    agentRecovery: { list: apiMocks.recoveryList, resume: vi.fn() },
  },
}))
// 只有接收侧事件：fleet 不发订阅帧，这里把「有没有挂 listener」也变成可断言的东西
vi.mock('@/lib/stream-events', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stream-events')>('@/lib/stream-events')
  return {
    ...actual,
    subscribeStreamEvent: (type: string, listener: (detail: unknown) => void) => {
      streamMocks.listeners.add(listener)
      return () => streamMocks.listeners.delete(listener)
    },
  }
})
vi.mock('@/lib/inbox-navigation', () => ({ navigateInboxRoute: navigateMock }))
// 守一条架构约束：fleet 只消费已推来的帧，绝不自己发 agent_subscribe（服务端每连接只挂
// 一个 monitor listener，见 routes/stream.ts，多订阅只会多一路重复帧）
const sendMock = vi.hoisted(() => vi.fn((_frame: Record<string, unknown>) => true))
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: sendMock, isSocketReady: true }),
}))

const host = (overrides: Partial<Host> = {}): Host =>
  ({ id: 'local', name: 'local', address: '', status: 'online', tags: [], ...overrides }) as Host
const pane = (overrides: Partial<AgentPaneState> = {}): AgentPaneState =>
  ({
    paneId: 'local:%1',
    tmuxPaneId: '%1',
    sessionName: 'dev',
    agent: 'claude',
    agentStatus: 'working',
    revision: 1,
    ...overrides,
  }) as AgentPaneState
const session = (name: string, agents: AgentPaneState[], hostId = 'local'): Session =>
  ({ id: `${hostId}:${name}`, hostId, name, createdAt: '', lastActiveAt: '', windowCount: 1, agents }) as Session
const candidate = (overrides: Partial<AgentRecoveryCandidate> = {}): AgentRecoveryCandidate =>
  ({
    id: 'c1',
    hostId: 'local',
    sessionName: 'dev',
    paneId: 'local:%1',
    tmuxPaneId: '%1',
    agent: 'claude',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    reason: 'pane_exited',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    resumable: true,
    occupant: 'shell',
    ...overrides,
  }) as AgentRecoveryCandidate

const sessions: Record<string, Session[]> = {
  local: [
    session('dev', [
      pane({ paneId: 'local:%1', tmuxPaneId: '%1', agentStatus: 'working' }),
      pane({ paneId: 'local:%2', tmuxPaneId: '%2', agentStatus: 'blocked', since: '2026-01-01T11:00:00.000Z' }),
    ]),
  ],
}
// pane 列表是任务号与序号的来源：只有它在，表格才会显示 T-236 而不是 —
const panes: Record<string, unknown[]> = {
  'local:local:dev': [
    { id: 'local:%1', tmuxPaneId: '%1', index: 0 },
    { id: 'local:%2', tmuxPaneId: '%2', index: 1, task: 'T-236' },
  ],
}

const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrap = (client: QueryClient, node: React.ReactNode) =>
  render(React.createElement(QueryClientProvider, { client }, React.createElement(I18nProvider, null, node)))

beforeEach(() => {
  streamMocks.listeners.clear()
  navigateMock.mockReset()
  navigateMock.mockResolvedValue('pane')
  apiMocks.list.mockReset()
  apiMocks.listBySession.mockReset()
  apiMocks.recoveryList.mockReset()
  apiMocks.list.mockImplementation(async (hostId: string) => sessions[hostId] || [])
  apiMocks.listBySession.mockImplementation(
    async (hostId: string, sessionId: string) => panes[`${hostId}:${sessionId}`] || [],
  )
  apiMocks.recoveryList.mockImplementation(async (hostId: string) => ({
    version: 1,
    candidates: hostId === 'local' ? [candidate()] : [],
  }))
})
afterEach(cleanup)

describe('FleetPanel', () => {
  it('renders rows grouped by host with the blocked row first and the task column filled', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    wrap(makeClient(), React.createElement(FleetPanel))
    // 默认「只看需处理」开着：只剩 blocked 那行，working 那行被过滤掉
    await waitFor(() => expect(document.querySelectorAll('[data-fleet-row]')).toHaveLength(1))
    expect(document.querySelector('[data-fleet-row]')?.getAttribute('data-fleet-row')).toBe('local:local:%2')
    expect(screen.getByLabelText('等待处理')).toBeTruthy()
    expect(screen.getByText('T-236')).toBeTruthy()
  })

  it('jumps to the pane through the existing select action', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    panes['local:local:dev'] = [{ id: 'local:%2', tmuxPaneId: '%2', index: 1, task: 'T-236' }]
    wrap(makeClient(), React.createElement(FleetPanel))
    const jump = await screen.findByRole('button', { name: /跳到 pane/ })
    act(() => jump.click())
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        { hostId: 'local', sessionName: 'dev', paneId: 'local:%2' },
        expect.anything(),
      ),
    )
  })

  it('shows the recovery action only on rows that have a pending candidate', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    apiMocks.recoveryList.mockImplementation(async () => ({
      version: 1,
      candidates: [candidate({ paneId: 'local:%1' })],
    }))
    wrap(makeClient(), React.createElement(FleetPanel))
    await waitFor(() => expect(document.querySelectorAll('[data-fleet-row]')).toHaveLength(1))
    // 候选挂在 %1（working 行），默认过滤下不可见；关掉「只看需处理」后应出现且只出现一次
    expect(screen.queryAllByRole('button', { name: '可恢复的 Agent' })).toHaveLength(0)
    const toggle = screen.getByRole('button', { name: '只看需处理' })
    act(() => toggle.click())
    await waitFor(() => expect(document.querySelectorAll('[data-fleet-row]')).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: '可恢复的 Agent' })).toHaveLength(1)
  })
})

describe('FleetPanel empty and degraded states', () => {
  it('explains how to install the hook when no agent pane exists', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    apiMocks.list.mockImplementation(async () => [session('dev', [])])
    wrap(makeClient(), React.createElement(FleetPanel))
    // 「只看需处理」开着也不该把空态变成「没匹配」：机队本来就没有 agent
    expect(await screen.findByText('本机还没有 agent pane')).toBeTruthy()
    expect(screen.getByText(/agent-push/)).toBeTruthy()
  })

  it('marks the host group as disconnected instead of failing the whole panel', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host({ id: 'devbox', name: 'devbox' })])
    apiMocks.list.mockImplementation(async () => [
      session('ops', [pane({ paneId: 'devbox:%1', agentStatus: 'unknown', phase: 'disconnected' })], 'devbox'),
    ])
    wrap(makeClient(), React.createElement(FleetPanel))
    // unknown/disconnected 不算「需要我处理」，默认过滤下先放宽才看得到
    act(() => screen.getByRole('button', { name: '只看需处理' }).click())
    expect(await screen.findByText('disconnected')).toBeTruthy()
    expect(document.querySelectorAll('[data-fleet-row]')).toHaveLength(1)
  })
})

describe('FleetPanel transport discipline', () => {
  it('never emits an agent subscription frame', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    sendMock.mockClear()
    wrap(makeClient(), React.createElement(FleetPanel))
    await waitFor(() => expect(document.querySelectorAll('[data-fleet-row]')).toHaveLength(1))
    expect(sendMock.mock.calls.filter((call) => JSON.stringify(call[0]).includes('agent_subscribe'))).toEqual([])
  })
})

describe('useFleetData network discipline', () => {
  it('does not load anything while the panel is not visible', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    const client = makeClient()
    const { result } = renderHook(() => useFleetData({ visible: false }), {
      wrapper: ({ children }) => React.createElement(QueryClientProvider, { client }, children),
    })
    // 等 hosts 真的到齐再断言「什么都没拉」：否则请求还没到触发的时刻，断言是空跑
    await waitFor(() => expect(result.current.hosts.length).toBe(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(result.current.fleet.total).toBe(0)
    expect(apiMocks.list).not.toHaveBeenCalled()
    expect(apiMocks.listBySession).not.toHaveBeenCalled()
    expect(apiMocks.recoveryList).not.toHaveBeenCalled()
  })

  it('loads each host once when visible and installs no recurring agent polling', async () => {
    vi.mocked((await import('@/lib/api')).api.hosts.list).mockResolvedValue([host()])
    const client = makeClient()
    const { result } = renderHook(() => useFleetData({ visible: true }), {
      wrapper: ({ children }) => React.createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(result.current.fleet.total).toBe(2))
    expect(apiMocks.list).toHaveBeenCalledTimes(1)
    expect(apiMocks.listBySession).toHaveBeenCalledTimes(1)
  })
})

describe('useFleetAlign', () => {
  it('only realigns when the push channel went quiet, and never while a frame keeps arriving', async () => {
    vi.useFakeTimers()
    const refetch = vi.fn()
    renderHook(() => useFleetAlign({ enabled: true, refetch, intervalMs: 30000 }))
    expect(streamMocks.listeners.size).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000)
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    // 有帧到达：下一个 30s 窗口不算「安静」，不该再拉全量
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
      for (const listener of streamMocks.listeners) listener({})
      await vi.advanceTimersByTimeAsync(25000)
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('installs neither listener nor timer when the panel is hidden', async () => {
    vi.useFakeTimers()
    const refetch = vi.fn()
    renderHook(() => useFleetAlign({ enabled: false, refetch, intervalMs: 30000 }))
    expect(streamMocks.listeners.size).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000)
    })
    expect(refetch).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('countFleetFromCache', () => {
  it('counts only blocked panes out of the sessions cache', () => {
    expect(
      countFleetFromCache([
        { queryKey: ['sessions', 'local'], data: sessions.local },
        { queryKey: ['hosts'], data: [{ id: 'local' }] },
      ]),
    ).toEqual({ blocked: 1, total: 2 })
  })
})
