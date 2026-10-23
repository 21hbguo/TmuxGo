import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneNotifications, WatchButton } from './PaneNotifications'

interface NotificationStub {
  (title: string, options?: NotificationOptions): { close: () => void }
  permission: NotificationPermission
}

const mocks = vi.hoisted(() => {
  const queryCache = new Map<string, unknown>()
  return {
    preferenceState: { agentNotificationsEnabled: true, agentNotificationDurationMs: 5000 },
    consoleState: {
      activeHostId: 'local',
      activeSessionId: 'local:other',
      activePaneId: 'local:%0',
      setActiveHost: vi.fn(),
      setActiveSession: vi.fn(),
      setActivePane: vi.fn(),
    },
    queryCache,
    queryClient: {
      getQueryData: vi.fn((key: unknown[]) => queryCache.get(JSON.stringify(key))),
      // 整 host 替换要枚举该 host 下所有 snapshot 查询：按 queryKey 前缀过滤
      getQueryCache: () => ({
        findAll: ({ queryKey }: { queryKey: unknown[] }) =>
          [...queryCache.keys()]
            .map((key) => JSON.parse(key) as unknown[])
            .filter((key) => queryKey.every((part, index) => key[index] === part))
            .map((key) => ({ queryKey: key })),
      }),
      // setQueryData 支持「函数式更新」：入参是 unknown，函数分支按同形状调用
      setQueryData: vi.fn((key: unknown[], value: unknown) =>
        queryCache.set(
          JSON.stringify(key),
          typeof value === 'function'
            ? (value as (prev: unknown) => unknown)(queryCache.get(JSON.stringify(key)))
            : value,
        ),
      ),
    },
    snapshotGet: vi.fn(),
    streamSend: vi.fn(() => true),
    socketState: { ready: false },
    windowSelect: vi.fn(),
    paneSelect: vi.fn(),
  }
})
const { preferenceState, consoleState, queryCache, queryClient, snapshotGet, windowSelect, paneSelect } = mocks
const { streamSend, socketState } = mocks

vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => ({ preferences: mocks.preferenceState }) }))
// 组件现在依赖全局 socket 发 agent_subscribe/agent_seen 与 hosts 列表：
// 单测里既不该真连 socket，也不该要求 QueryClientProvider
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    send: mocks.streamSend,
    isConnected: mocks.socketState.ready,
    isSocketReady: mocks.socketState.ready,
    subscribeOutput: vi.fn(),
    retryConnection: vi.fn(),
  }),
}))
vi.mock('@/hooks/useApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useApi')>()),
  useHosts: () => ({ data: [{ id: 'local' }] }),
  useSessionSnapshot: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useOptionalQueryClient', () => ({ useOptionalQueryClient: () => mocks.queryClient }))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign(
    (selector: (state: typeof mocks.consoleState) => unknown) => selector(mocks.consoleState),
    {
      getState: () => mocks.consoleState,
    },
  ),
}))
vi.mock('@/lib/api', () => ({
  api: {
    snapshot: { get: mocks.snapshotGet },
    windows: { select: mocks.windowSelect },
    panes: { select: mocks.paneSelect },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const messages: Record<string, string> = {
        'agent.notification.blocked': `${params?.agent} blocked in ${params?.session}`,
        'agent.notification.done': `${params?.agent} finished in ${params?.session}`,
        'agent.notification.permission': `${params?.agent} permission required in ${params?.session}`,
        'agent.notification.question': `${params?.agent} needs input in ${params?.session}`,
        'agent.notification.failed': `${params?.agent} failed in ${params?.session}`,
        'agent.notification.ended': `${params?.agent} ended in ${params?.session}`,
        'agent.notification.disconnected': `${params?.agent} disconnected in ${params?.session}`,
      }
      return messages[key] || key
    },
  }),
}))

function emitAgentStatus(status: 'blocked' | 'done', revision: number) {
  emitStreamEvent(STREAM_EVENT.agentStatus, {
    hostId: 'local',
    sessionName: 'dev',
    pane: { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: status, revision },
  })
}

function agentPane(paneId: string, agentStatus: 'working' | 'done' | 'blocked', stateSeq: number) {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName: 'dev',
    agent: 'codex',
    agentStatus,
    revision: stateSeq,
    stateSeq,
  }
}
function emitAgentState(overrides: Record<string, unknown> = {}) {
  emitStreamEvent(STREAM_EVENT.agentState, {
    type: 'agent_state',
    agentProtoVersion: 1,
    subId: 'as_1',
    hostId: 'local',
    mode: 'full',
    seq: 1,
    stateSeq: 1,
    changed: [],
    removed: [],
    ...overrides,
  })
}

describe('PaneNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    preferenceState.agentNotificationsEnabled = true
    preferenceState.agentNotificationDurationMs = 5000
    queryCache.clear()
    streamSend.mockClear()
    socketState.ready = false
    snapshotGet.mockReset()
    windowSelect.mockReset()
    paneSelect.mockReset()
    windowSelect.mockResolvedValue({ ok: true })
    paneSelect.mockResolvedValue({ ok: true })
    consoleState.setActiveHost.mockReset()
    consoleState.setActiveSession.mockReset()
    consoleState.setActivePane.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('dismisses notifications after the configured duration', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 1))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4999))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
  })
  it('does not add notifications when they are disabled', () => {
    preferenceState.agentNotificationsEnabled = false
    render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 2))
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
  })
  it('does not show an empty notification popup', () => {
    render(<PaneNotifications />)
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')))
    expect(screen.queryByText('notification.empty')).not.toBeInTheDocument()
  })
  it('allows the notification bubble to be dragged and saves its position', () => {
    localStorage.setItem('tmuxgo-notification-bubble-position', JSON.stringify({ x: 40, y: 60 }))
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 10))
    const bubble = screen.getByRole('button', { name: 'notification.title' })
    fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 70 })
    fireEvent.pointerMove(bubble, { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 130 })
    fireEvent.pointerUp(bubble, { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 130 })
    expect(bubble).toHaveStyle({ left: '100px', top: '120px' })
    expect(JSON.parse(localStorage.getItem('tmuxgo-notification-bubble-position') || 'null')).toEqual({
      x: 100,
      y: 120,
    })
  })
  it('filters notifications from muted panes', () => {
    localStorage.setItem('tmuxgo-muted-pane-notifications', JSON.stringify(['local:%1']))
    render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 5))
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toEqual([])
  })
  it('restores an initial completed snapshot without notifying', () => {
    render(<PaneNotifications />)
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentStatus, {
        hostId: 'local',
        sessionName: 'dev',
        initial: true,
        pane: {
          paneId: 'local:%1',
          tmuxPaneId: '%1',
          sessionName: 'dev',
          agent: 'codex',
          agentStatus: 'done',
          revision: 8,
        },
      }),
    )
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toEqual([])
  })
  it('notifies from an explicit agent notification event', () => {
    render(<PaneNotifications />)
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentNotification, {
        type: 'agent_notification',
        hostId: 'local',
        sessionName: 'dev',
        eventId: 'local:local:%1:completed:9',
        pane: {
          paneId: 'local:%1',
          tmuxPaneId: '%1',
          sessionName: 'dev',
          agent: 'codex',
          agentStatus: 'idle',
          phase: 'idle',
          lastEvent: 'completed',
          revision: 9,
        },
      }),
    )
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('deduplicates explicit notifications by event id', () => {
    render(<PaneNotifications />)
    const detail = {
      type: 'agent_notification',
      hostId: 'local',
      sessionName: 'dev',
      eventId: 'local:local:%1:failed:10',
      pane: {
        paneId: 'local:%1',
        tmuxPaneId: '%1',
        sessionName: 'dev',
        agent: 'codex',
        agentStatus: 'unknown',
        phase: 'failed',
        lastEvent: 'failed',
        revision: 10,
      },
    }
    act(() => {
      emitStreamEvent(STREAM_EVENT.agentNotification, detail)
      emitStreamEvent(STREAM_EVENT.agentNotification, detail)
    })
    expect(screen.getAllByText('codex failed in dev')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('redacts paths in notification messages', () => {
    render(<PaneNotifications />)
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentNotification, {
        type: 'agent_notification',
        hostId: 'local',
        sessionName: 'dev',
        eventId: 'local:local:%1:failed:11',
        pane: {
          paneId: 'local:%1',
          tmuxPaneId: '%1',
          sessionName: 'dev',
          agent: 'codex',
          agentStatus: 'unknown',
          phase: 'failed',
          lastEvent: 'failed',
          message: 'secret command /home/user/private prompt',
          revision: 11,
        },
      }),
    )
    expect(screen.getByText('secret command [path] prompt')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/home/user/private')
    expect(localStorage.getItem('tmuxgo-pane-notifications')).not.toContain('/home/user/private')
  })
  it('clears agent metadata but keeps the terminal pane when it is removed', () => {
    queryCache.set(JSON.stringify(['session-snapshot', 'local', 'session-local-dev']), {
      panes: [
        {
          id: 'local:%1',
          windowId: 'local:@1',
          title: 'codex',
          agent: 'codex',
          agentStatus: 'working',
          phase: 'working',
          revision: 3,
        },
      ],
    })
    render(<PaneNotifications />)
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentStatusRemoved, {
        type: 'agent_status_removed',
        hostId: 'local',
        sessionName: 'dev',
        paneId: 'local:%1',
        reason: 'pane_exited',
      }),
    )
    expect(queryClient.getQueryData(['session-snapshot', 'local', 'session-local-dev'])).toEqual({
      panes: [{ id: 'local:%1', windowId: 'local:@1', title: 'codex' }],
    })
  })
  it('does not show a duplicate notification after reconnecting', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 9))
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentStatus, {
        hostId: 'local',
        sessionName: 'dev',
        initial: true,
        pane: {
          paneId: 'local:%1',
          tmuxPaneId: '%1',
          sessionName: 'dev',
          agent: 'codex',
          agentStatus: 'done',
          revision: 9,
        },
      }),
    )
    expect(screen.getAllByText('codex finished in dev')).toHaveLength(1)
  })
  it('keeps notification history after the popup duration', () => {
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 6))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
    act(() => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')))
    expect(screen.getByText('codex finished in dev')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('tmuxgo-pane-notifications') || '[]')).toHaveLength(1)
  })
  it('uses a browser notification while the page is hidden', () => {
    const originalNotification = window.Notification
    const close = vi.fn()
    // 浏览器通知桩：既要是可调用构造，又带 permission 静态字段
    const browserNotification = vi.fn(function (this: { close: () => void }) {
      this.close = close
    }) as unknown as NotificationStub
    browserNotification.permission = 'granted'
    Object.defineProperty(window, 'Notification', { configurable: true, value: browserNotification })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 7))
    expect(browserNotification).toHaveBeenCalledWith(
      'notification.title',
      expect.objectContaining({ body: 'codex finished in dev' }),
    )
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(window, 'Notification', { configurable: true, value: originalNotification })
  })
  it('clears visible notifications when they are disabled', () => {
    const { rerender } = render(<PaneNotifications />)
    act(() => emitAgentStatus('blocked', 3))
    expect(screen.getByText('codex blocked in dev')).toBeInTheDocument()
    preferenceState.agentNotificationsEnabled = false
    rerender(<PaneNotifications />)
    expect(screen.queryByText('codex blocked in dev')).not.toBeInTheDocument()
  })
  it('watches panes by default and allows muting them', () => {
    render(<WatchButton paneId="local:%1" />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    expect(JSON.parse(localStorage.getItem('tmuxgo-muted-pane-notifications') || '[]')).toEqual(['local:%1'])
  })
  it('opens the target window and pane when a notification is clicked', async () => {
    vi.useRealTimers()
    snapshotGet
      .mockResolvedValueOnce({
        activeWindowId: 'local:@1',
        activePaneId: 'local:%0',
        panes: [{ id: 'local:%1', windowId: 'local:@2', active: false }],
      })
      .mockResolvedValueOnce({
        activeWindowId: 'local:@2',
        activePaneId: 'local:%1',
        panes: [{ id: 'local:%1', windowId: 'local:@2', active: true }],
      })
    render(<PaneNotifications />)
    act(() => emitAgentStatus('done', 4))
    fireEvent.click(screen.getByText('codex finished in dev'))
    await waitFor(() => expect(consoleState.setActivePane).toHaveBeenCalledWith('local:%1'))
    expect(windowSelect).toHaveBeenCalledWith('local', 'session-local-dev', 'local:@2')
    expect(paneSelect).toHaveBeenCalledWith('local:%1')
    expect(snapshotGet).toHaveBeenCalledTimes(2)
    expect(consoleState.setActiveSession).toHaveBeenCalledWith('session-local-dev')
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['session-snapshot', 'local', 'session-local-dev'],
      expect.objectContaining({ activePaneId: 'local:%1' }),
    )
    expect(screen.queryByText('codex finished in dev')).not.toBeInTheDocument()
  })
  it('replaces the whole host view on a full agent_state frame', () => {
    // 没有订阅就收不到帧（客户端会丢弃未订阅 host 的帧）：先让 socket 就绪完成订阅
    socketState.ready = true
    queryCache.set(JSON.stringify(['session-snapshot', 'local', 'session-local-dev']), {
      panes: [
        { id: 'local:%1', windowId: 'local:@1', title: 'codex' },
        { id: 'local:%2', windowId: 'local:@1', title: 'shell', agent: 'codex', agentStatus: 'done', revision: 4 },
      ],
    })
    render(<PaneNotifications />)
    act(() => emitAgentState({ mode: 'full', seq: 1, stateSeq: 7, changed: [agentPane('local:%1', 'working', 7)] }))
    // full 是整 host 的真相：帧里没有的 pane 必须丢掉 agent 元数据，不能留着旧 done
    expect(queryClient.getQueryData(['session-snapshot', 'local', 'session-local-dev'])).toEqual({
      panes: [
        expect.objectContaining({ id: 'local:%1', agentStatus: 'working', stateSeq: 7 }),
        { id: 'local:%2', windowId: 'local:@1', title: 'shell' },
      ],
    })
  })
  it('merges delta frames by pane and drops the older stateSeq', () => {
    // 没有订阅就收不到帧（客户端会丢弃未订阅 host 的帧）：先让 socket 就绪完成订阅
    socketState.ready = true
    queryCache.set(JSON.stringify(['session-snapshot', 'local', 'session-local-dev']), {
      panes: [
        { id: 'local:%1', windowId: 'local:@1', title: 'codex', agent: 'codex', agentStatus: 'done', revision: 4 },
      ],
    })
    render(<PaneNotifications />)
    act(() => emitAgentState({ mode: 'full', seq: 1, stateSeq: 7, changed: [agentPane('local:%1', 'done', 7)] }))
    act(() => emitAgentState({ mode: 'delta', seq: 2, stateSeq: 8, changed: [agentPane('local:%1', 'working', 8)] }))
    const readPanes = () =>
      (
        queryClient.getQueryData(['session-snapshot', 'local', 'session-local-dev']) as
          { panes: Array<Record<string, unknown>> } | undefined
      )?.panes || []
    expect(readPanes()[0]).toMatchObject({ agentStatus: 'working', stateSeq: 8 })
    // 迟到的旧 delta（stateSeq 更小）不得把状态倒回 done
    act(() => emitAgentState({ mode: 'delta', seq: 3, stateSeq: 5, changed: [agentPane('local:%1', 'done', 5)] }))
    expect(readPanes()[0]).toMatchObject({ agentStatus: 'working', stateSeq: 8 })
  })
  it('strips pane metadata for removals carried by a delta frame', () => {
    // 没有订阅就收不到帧（客户端会丢弃未订阅 host 的帧）：先让 socket 就绪完成订阅
    socketState.ready = true
    queryCache.set(JSON.stringify(['session-snapshot', 'local', 'session-local-dev']), {
      panes: [
        { id: 'local:%1', windowId: 'local:@1', title: 'codex', agent: 'codex', agentStatus: 'working', revision: 3 },
      ],
    })
    render(<PaneNotifications />)
    act(() =>
      emitAgentState({
        mode: 'full',
        seq: 1,
        stateSeq: 4,
        changed: [agentPane('local:%1', 'working', 4)],
      }),
    )
    act(() =>
      emitAgentState({
        mode: 'delta',
        seq: 2,
        stateSeq: 5,
        changed: [],
        removed: [{ paneId: 'local:%1', sessionName: 'dev', reason: 'pane_exited' }],
      }),
    )
    expect(queryClient.getQueryData(['session-snapshot', 'local', 'session-local-dev'])).toEqual({
      panes: [{ id: 'local:%1', windowId: 'local:@1', title: 'codex' }],
    })
  })
  it('subscribes per host once the socket is ready and resyncs on a seq gap', () => {
    socketState.ready = true
    const { rerender } = render(<PaneNotifications />)
    rerender(<PaneNotifications />)
    expect(streamSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_subscribe', agentProtoVersion: 1, hostId: 'local', needFull: true }),
    )
    act(() => emitAgentState({ mode: 'full', seq: 1, stateSeq: 3 }))
    streamSend.mockClear()
    act(() => emitAgentState({ mode: 'delta', seq: 3, stateSeq: 4 }))
    expect(streamSend).toHaveBeenCalledWith({ type: 'agent_resync', subId: 'as_1' })
  })
  it('falls back to legacy frames when the gateway rejects the v1 subscribe', () => {
    socketState.ready = true
    const { rerender } = render(<PaneNotifications />)
    rerender(<PaneNotifications />)
    expect(streamSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_subscribe' }))
    // useWebSocket 已把 "Unknown message type: agent_subscribe" 归一成能力协商失败事件
    act(() =>
      emitStreamEvent(STREAM_EVENT.agentFeedUnsupported, {
        type: 'error',
        message: 'Unknown message type: agent_subscribe',
      }),
    )
    streamSend.mockClear()
    act(() => emitStreamEvent(STREAM_EVENT.reconnected))
    expect(streamSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_subscribe' }))
    // legacy 帧照旧生效（双发期的兜底路径）
    act(() => emitAgentStatus('blocked', 11))
    expect(screen.getByText('codex blocked in dev')).toBeInTheDocument()
  })
})
