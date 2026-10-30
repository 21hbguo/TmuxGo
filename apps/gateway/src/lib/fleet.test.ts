import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentPaneState } from './agent-state.js'
import { buildFleetList, FLEET_MAX_LIMIT } from './fleet.js'

function state(overrides: Partial<AgentPaneState> = {}): AgentPaneState {
  return {
    paneId: 'local:%0',
    tmuxPaneId: '%0',
    sessionName: 'dev',
    agent: 'claude',
    agentStatus: 'working',
    revision: 1,
    ...overrides,
  }
}

test('sorts by attention rank then longest-waiting first', () => {
  const result = buildFleetList([
    state({ paneId: 'local:%1', tmuxPaneId: '%1', agentStatus: 'idle' }),
    state({ paneId: 'local:%2', tmuxPaneId: '%2', agentStatus: 'working', since: '2026-10-30T00:00:00.000Z' }),
    state({ paneId: 'local:%3', tmuxPaneId: '%3', agentStatus: 'blocked', since: '2026-10-30T01:00:00.000Z' }),
    state({ paneId: 'local:%4', tmuxPaneId: '%4', agentStatus: 'done' }),
    // failed 不是独立 status：phase/lastEvent 命中即排到 blocked 之后、done 之前
    state({ paneId: 'local:%5', tmuxPaneId: '%5', agentStatus: 'working', phase: 'failed' }),
    state({ paneId: 'local:%6', tmuxPaneId: '%6', agentStatus: 'working', since: '2026-10-29T00:00:00.000Z' }),
  ])
  assert.deepEqual(
    result.panes.map((pane) => pane.paneId),
    ['local:%3', 'local:%5', 'local:%4', 'local:%6', 'local:%2', 'local:%1'],
  )
  assert.deepEqual(result.summary, { idle: 1, working: 3, blocked: 1, done: 1, unknown: 0, total: 6 })
  assert.equal(result.truncated, false)
})

test('marks needsHuman only for blocked and failed rows', () => {
  const result = buildFleetList([
    state({ paneId: 'local:%0', agentStatus: 'blocked' }),
    state({ paneId: 'local:%1', tmuxPaneId: '%1', agentStatus: 'idle', lastEvent: 'failed' }),
    state({ paneId: 'local:%2', tmuxPaneId: '%2', agentStatus: 'done' }),
  ])
  assert.deepEqual(
    result.panes.map((pane) => pane.needsHuman),
    [true, true, false],
  )
})

test('filters by host, status, exact task and agent name', () => {
  const states = [
    state({ paneId: 'local:%0', task: 'T-1', agent: 'claude' }),
    state({ paneId: 'remote:%1', tmuxPaneId: '%1', task: 'T-2', agent: 'codex', agentStatus: 'blocked' }),
    state({ paneId: 'local:%2', tmuxPaneId: '%2', task: '  T-1  ', agent: 'codex', agentStatus: 'idle' }),
    state({ paneId: 'local:%3', tmuxPaneId: '%3', agentStatus: 'idle' }),
  ]
  assert.deepEqual(
    buildFleetList(states, { hostIds: ['local'] }).panes.map((pane) => pane.paneId),
    ['local:%0', 'local:%2', 'local:%3'],
  )
  assert.deepEqual(
    buildFleetList(states, { statuses: ['blocked'] }).panes.map((pane) => pane.paneId),
    ['remote:%1'],
  )
  // 任务号对原文 trim 后精确匹配：'  T-1  ' 与 'T-1' 是同一个任务
  assert.deepEqual(
    buildFleetList(states, { task: 'T-1' })
      .panes.map((pane) => pane.paneId)
      .sort(),
    ['local:%0', 'local:%2'],
  )
  assert.deepEqual(
    buildFleetList(states, { agent: 'CODEX' })
      .panes.map((pane) => pane.paneId)
      .sort(),
    ['local:%2', 'remote:%1'],
  )
  // summary 只统计匹配集合（过滤后、截断前）
  assert.equal(buildFleetList(states, { hostIds: ['local'] }).summary.total, 3)
})

test('trims task, keeps null when unbound, and flags self by pane id or raw tmux pane id', () => {
  const states = [
    state({ paneId: 'local:%7', tmuxPaneId: '%7', task: '   ' }),
    state({ paneId: 'local:%8', tmuxPaneId: '%8' }),
  ]
  const byHostPane = buildFleetList(states, { selfPaneId: 'local:%7' })
  assert.deepEqual(
    byHostPane.panes.map((pane) => [pane.task, pane.self]),
    [
      [null, true],
      [null, false],
    ],
  )
  const byTmuxPane = buildFleetList(states, { selfPaneId: '%8' })
  assert.equal(byTmuxPane.panes.find((pane) => pane.self)?.paneId, 'local:%8')
})

test('respects the session allow-list and never leaks disallowed sessions', () => {
  const states = [
    state({ paneId: 'local:%0', sessionName: 'dev' }),
    state({ paneId: 'remote:%1', tmuxPaneId: '%1', sessionName: 'secret' }),
  ]
  const result = buildFleetList(states, { allowSession: (_host, session) => session !== 'secret' })
  assert.deepEqual(
    result.panes.map((pane) => pane.sessionName),
    ['dev'],
  )
  assert.equal(result.summary.total, 1)
})

test('caps the page and reports truncation with the full matched summary', () => {
  const states = Array.from({ length: 8 }, (_, index) =>
    state({ paneId: `local:%${index}`, tmuxPaneId: `%${index}`, agentStatus: 'working' }),
  )
  const page = buildFleetList(states, { limit: 3 })
  assert.equal(page.panes.length, 3)
  assert.equal(page.truncated, true)
  assert.equal(page.summary.total, 8)
  // 上限收敛到协议上限，避免调用方传 1e9 把响应撑爆
  assert.equal(buildFleetList(states, { limit: 100000 }).panes.length, states.length)
  assert.equal(FLEET_MAX_LIMIT, 500)
})

test('empty fleet returns zeroed summary, not an error', () => {
  const result = buildFleetList([])
  assert.deepEqual(result.panes, [])
  assert.deepEqual(result.summary, { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, total: 0 })
  assert.equal(result.truncated, false)
})

test('missing since sorts after known timestamps inside the same rank', () => {
  const result = buildFleetList([
    state({ paneId: 'local:%1', tmuxPaneId: '%1', agentStatus: 'working' }),
    state({ paneId: 'local:%2', tmuxPaneId: '%2', agentStatus: 'working', since: '2026-10-30T00:00:00.000Z' }),
  ])
  assert.deepEqual(
    result.panes.map((pane) => pane.paneId),
    ['local:%2', 'local:%1'],
  )
})
