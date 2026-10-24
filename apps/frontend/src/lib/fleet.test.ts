import { describe, expect, it } from 'vitest'
import { buildFleet, fleetRank, formatFleetDuration, parseFleetTask } from './fleet'
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
