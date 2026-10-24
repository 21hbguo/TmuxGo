import { describe, expect, it } from 'vitest'
import { buildFleet, buildFleetTree, fleetRank, formatFleetDuration, parseFleetTask } from './fleet'
import type { AgentPaneState, AgentRecoveryCandidate, Host, Pane, Session } from '@/types'

const host = (overrides: Partial<Host> = {}): Host =>
  ({ id: 'local', name: 'local', status: 'online', tags: [], connectionMode: 'local', ...overrides }) as Host
const remote = (overrides: Partial<Host> = {}): Host =>
  ({ id: 'devbox', name: 'devbox', status: 'online', tags: [], connectionMode: 'ssh', ...overrides }) as Host
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
// pane 列表（带 task/index 的冷数据）：fleet 的任务列与 pane 序号都从这里来
const paneRow = (id: string, overrides: Partial<Pane> = {}): Pane =>
  ({ id, windowId: 'w', index: 0, title: 'sh', active: false, size: { cols: 80, rows: 24 }, ...overrides }) as Pane
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

describe('fleetRank', () => {
  it('puts blocked first, then failed, done, working, idle, unknown', () => {
    const order = [
      { status: 'unknown' as const },
      { status: 'idle' as const },
      { status: 'working' as const },
      { status: 'done' as const },
      { status: 'working' as const, phase: 'failed' as const },
      { status: 'blocked' as const },
    ]
    const sorted = [...order].sort((a, b) => fleetRank(a) - fleetRank(b))
    expect(sorted.map((item) => `${item.status}:${item.phase || ''}`)).toEqual([
      'blocked:',
      'working:failed',
      'done:',
      'working:',
      'idle:',
      'unknown:',
    ])
  })

  it('treats a failed last event as failed even when the status has not caught up', () => {
    expect(fleetRank({ status: 'working', lastEvent: 'failed' })).toBe(
      fleetRank({ status: 'working', phase: 'failed' }),
    )
    expect(fleetRank({ status: 'working', lastEvent: 'failed' })).toBeLessThan(fleetRank({ status: 'working' }))
  })
})

describe('parseFleetTask / formatFleetDuration', () => {
  it('treats blank task as unbound instead of an empty string', () => {
    expect(parseFleetTask('  ')).toBeNull()
    expect(parseFleetTask(undefined)).toBeNull()
    expect(parseFleetTask(' T-236 ')).toBe('T-236')
  })

  it('formats dwell time in s/m/h/d and keeps empty input empty', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    expect(formatFleetDuration('2026-01-01T11:59:30.000Z', now)).toBe('30s')
    expect(formatFleetDuration('2026-01-01T11:48:00.000Z', now)).toBe('12m')
    expect(formatFleetDuration('2026-01-01T09:00:00.000Z', now)).toBe('3h')
    expect(formatFleetDuration('2025-12-30T12:00:00.000Z', now)).toBe('2d')
    expect(formatFleetDuration(null, now)).toBe('')
    expect(formatFleetDuration('not-a-date', now)).toBe('')
  })
})

describe('buildFleet', () => {
  const hosts = [host(), remote()]
  const sessions = {
    local: [
      session('dev', [
        pane({ paneId: 'local:%1', tmuxPaneId: '%1', agentStatus: 'working', since: '2026-01-01T11:00:00.000Z' }),
        pane({
          paneId: 'local:%2',
          tmuxPaneId: '%2',
          agentStatus: 'blocked',
          since: '2026-01-01T11:58:00.000Z',
        }),
      ]),
    ],
    devbox: [session('ops', [pane({ paneId: 'devbox:%7', tmuxPaneId: '%7', agentStatus: 'idle' })], 'devbox')],
  }

  const panes = {
    'local:local:dev': [paneRow('local:%1', { index: 0 }), paneRow('local:%2', { index: 1, task: 'T-236' })],
  }

  it('groups rows by host and sorts blocked before working across hosts', () => {
    const fleet = buildFleet({ hosts, sessionsByHost: sessions, panesBySession: panes })
    expect(fleet.total).toBe(3)
    expect(fleet.rows[0].status).toBe('blocked')
    // 任务号取 pane 列表那一份，agents 帧本身不带 task
    expect(fleet.rows[0].task).toBe('T-236')
    expect(fleet.rows[0].paneIndex).toBe(1)
    expect(fleet.groups.map((group) => group.hostId)).toEqual(['local', 'devbox'])
    expect(fleet.groups[0].rows.map((row) => row.paneId)).toEqual(['local:%2', 'local:%1'])
  })

  it('orders same-status rows by since ascending so the longest-stuck shows first', () => {
    const fleet = buildFleet({
      hosts: [host()],
      sessionsByHost: {
        local: [
          session('dev', [
            pane({ paneId: 'local:%1', agentStatus: 'working', since: '2026-01-01T11:30:00.000Z' }),
            pane({ paneId: 'local:%2', agentStatus: 'working', since: '2026-01-01T10:00:00.000Z' }),
          ]),
        ],
      },
    })
    expect(fleet.rows.map((row) => row.paneId)).toEqual(['local:%2', 'local:%1'])
  })

  it('filters to attention rows by default switch, by host, by task and by query', () => {
    const attention = buildFleet({ hosts, sessionsByHost: sessions, filters: { needsAttention: true } })
    expect(attention.rows.map((row) => row.paneId)).toEqual(['local:%2'])

    const oneHost = buildFleet({ hosts, sessionsByHost: sessions, filters: { hostIds: ['devbox'] } })
    expect(oneHost.rows.map((row) => row.hostId)).toEqual(['devbox'])

    const withTask = buildFleet({
      hosts,
      sessionsByHost: sessions,
      panesBySession: panes,
      filters: { hasTaskOnly: true },
    })
    expect(withTask.rows.map((row) => row.task)).toEqual(['T-236'])

    const searched = buildFleet({ hosts, sessionsByHost: sessions, panesBySession: panes, filters: { query: 'ops' } })
    expect(searched.rows.map((row) => row.paneId)).toEqual(['devbox:%7'])
  })

  it('attaches only pending recovery candidates to their rows', () => {
    const fleet = buildFleet({
      hosts: [host()],
      sessionsByHost: sessions,
      recoveryByHost: {
        local: [candidate(), candidate({ id: 'c2', paneId: 'local:%2', status: 'resumed' })],
      },
    })
    expect(fleet.rows.find((row) => row.paneId === 'local:%1')?.recovery?.id).toBe('c1')
    expect(fleet.rows.find((row) => row.paneId === 'local:%2')?.recovery).toBeNull()
    expect(fleet.withRecovery).toBe(1)
  })

  it('marks a host group unreachable when every row reports disconnected', () => {
    const fleet = buildFleet({
      hosts: [host(), remote()],
      sessionsByHost: {
        local: [session('dev', [pane({ paneId: 'local:%1' })])],
        devbox: [
          session('ops', [pane({ paneId: 'devbox:%1', agentStatus: 'unknown', phase: 'disconnected' })], 'devbox'),
        ],
      },
    })
    expect(fleet.groups.find((group) => group.hostId === 'devbox')?.unreachable).toBe(true)
    expect(fleet.groups.find((group) => group.hostId === 'local')?.unreachable).toBe(false)
  })

  it('drops a host group that has no row left after filtering', () => {
    const fleet = buildFleet({ hosts, sessionsByHost: sessions, panesBySession: panes, filters: { query: 'T-236' } })
    expect(fleet.groups.map((group) => group.hostId)).toEqual(['local'])
  })
})

describe('buildFleetTree', () => {
  const agents = (ids: string[]) => ids.map((id) => pane({ paneId: `local:${id}`, tmuxPaneId: id }))

  it('orders windows by windowIndex and panes by index inside each window', () => {
    const fleet = buildFleet({
      hosts: [host()],
      sessionsByHost: { local: [session('dev', agents(['%3', '%1', '%2']))] },
      panesBySession: {
        'local:local:dev': [
          paneRow('local:%3', { index: 0, windowId: 'local:@2', windowName: 'serve', windowIndex: 1 }),
          paneRow('local:%1', { index: 1, windowId: 'local:@1', windowName: 'edit', windowIndex: 0 }),
          paneRow('local:%2', { index: 0, windowId: 'local:@1', windowName: 'edit', windowIndex: 0 }),
        ],
      },
    })
    const tree = buildFleetTree(fleet.groups[0].rows)
    expect(tree).toHaveLength(1)
    expect(tree[0].windows.map((window) => window.windowName)).toEqual(['edit', 'serve'])
    expect(tree[0].rows.map((row) => row.tmuxPaneId)).toEqual(['%2', '%1', '%3'])
    // window/pane 元数据落到叶子上，面板才有东西画层级
    expect(tree[0].rows[0]).toMatchObject({ windowName: 'edit', windowIndex: 0, paneIndex: 0 })
  })

  it('sorts session nodes by the best rank inside, with the longest-stuck as tie-break', () => {
    const fleet = buildFleet({
      hosts: [host()],
      sessionsByHost: {
        local: [
          session('alpha', [pane({ paneId: 'local:%1', agentStatus: 'working', since: '2026-01-01T10:00:00.000Z' })]),
          session('beta', [pane({ paneId: 'local:%2', agentStatus: 'working', since: '2026-01-01T11:00:00.000Z' })]),
          session('gamma', [pane({ paneId: 'local:%3', agentStatus: 'blocked' })]),
        ],
      },
    })
    const tree = buildFleetTree(fleet.groups[0].rows)
    expect(tree.map((node) => node.sessionName)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('falls back to a single anonymous window while pane metadata is still loading', () => {
    const fleet = buildFleet({ hosts: [host()], sessionsByHost: { local: [session('dev', agents(['%1', '%2']))] } })
    const tree = buildFleetTree(fleet.groups[0].rows)
    // 没有 windowId/windowIndex 时不能凭空造出一堆 window 行：单组 → 面板按单 window 渲染
    expect(tree[0].windows).toHaveLength(1)
    expect(tree[0].rows.map((row) => row.windowIndex)).toEqual([null, null])
  })

  it('prefers the live agent message and keeps the pane title as the brief fallback', () => {
    const fleet = buildFleet({
      hosts: [host()],
      sessionsByHost: {
        local: [
          session('dev', [
            pane({ paneId: 'local:%1', tmuxPaneId: '%1', message: 'live message' }),
            pane({ paneId: 'local:%2', tmuxPaneId: '%2' }),
          ]),
        ],
      },
      panesBySession: {
        'local:local:dev': [
          paneRow('local:%1', { title: 'claude', message: 'stale copy' }),
          paneRow('local:%2', { title: 'nvim README.md' }),
        ],
      },
    })
    const [first, second] = fleet.rows
    // agents 帧实时 patch 更准；pane 列表那份可能是上一轮抓的
    expect(first.message).toBe('live message')
    expect(first.paneTitle).toBe('claude')
    expect(second.message).toBeNull()
    expect(second.paneTitle).toBe('nvim README.md')
  })
})
