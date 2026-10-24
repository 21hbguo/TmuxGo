import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentMonitor, emptyScanBackoffMs, type AgentMonitorEvent } from './agent-monitor.js'
import type { AgentPaneState } from './agent-state.js'
import type { RecoveryCandidateInput } from './agent-recovery.js'

// 测试缝：refreshHosts 是私有方法，单测按结构化断言取用（不改实现可见性）
function callRefreshHosts(monitor: AgentMonitor, pollNewHosts?: boolean) {
  return (monitor as unknown as { refreshHosts: (pollNewHosts?: boolean) => Promise<void> }).refreshHosts(pollNewHosts)
}

type RemovedEvent = Extract<AgentMonitorEvent, { type: 'agent_status_removed' }>
// 事件是判别联合：断言里要取 removed 专属字段，先用谓词收窄再 find
function findRemoved(events: AgentMonitorEvent[], paneId: string) {
  return events.find((event): event is RemovedEvent => event.type === 'agent_status_removed' && event.paneId === paneId)
}

function pane(
  paneId: string,
  phase: AgentPaneState['phase'] = 'working',
  lastEvent: AgentPaneState['lastEvent'] = 'started',
): AgentPaneState {
  return {
    paneId,
    tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1),
    sessionName: 'dev',
    agent: 'codex',
    agentSessionId: paneId + ':dev',
    agentStatus:
      phase === 'working' ? 'working' : phase === 'idle' ? 'idle' : phase === 'failed' ? 'unknown' : 'blocked',
    phase,
    lastEvent,
    source: 'process',
    confidence: 'medium',
    since: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    eventId: paneId + ':' + (lastEvent || 'state'),
    revision: 1,
  }
}

test('a start racing a stop never leaves an orphan host-refresh interval behind', { timeout: 5000 }, async () => {
  // 回归：stop() 之后第一轮 start 的收尾仍可能挂上 hostRefreshTimer，再被下一轮
  // start 覆盖成无人引用的孤儿定时器 —— 进程于是永远退不掉（T-213 stream 文件级超时）
  const created: unknown[] = []
  const cleared = new Set<unknown>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  ;(globalThis as unknown as { setInterval: unknown }).setInterval = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const id = (realSetInterval as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest)
    created.push(id)
    return id
  }) as unknown as typeof setInterval
  ;(globalThis as unknown as { clearInterval: unknown }).clearInterval = ((id: unknown) => {
    cleared.add(id)
    return (realClearInterval as unknown as (i: unknown) => void)(id)
  }) as unknown as typeof clearInterval
  try {
    // 第一轮扫描故意慢（60ms）、第二轮快（10ms）：于是第二轮先挂上 hostRefreshTimer，
    // 第一轮的收尾随后再挂一次把它覆盖成孤儿 —— 交错方向固定，断言才是确定的
    let scanCalls = 0
    const monitor = new AgentMonitor({
      scan: async () => {
        scanCalls += 1
        await new Promise((r) => setTimeout(r, scanCalls === 1 ? 60 : 10))
        return [pane('local:%1')]
      },
      getHostIds: async () => ['local'],
      hostRefreshMs: 20,
      intervalMs: 20,
      idleMs: 20,
    })
    const first = monitor.start()
    await new Promise((r) => setTimeout(r, 3))
    monitor.stop() // 打断第一轮
    const second = monitor.start()
    await Promise.allSettled([first, second])
    monitor.stop()
    // 已建但从未被 clear 的定时器 = 孤儿：正是它让进程退不掉
    assert.deepEqual(
      created.filter((id) => !cleared.has(id)),
      [],
    )
  } finally {
    ;(globalThis as unknown as { setInterval: unknown }).setInterval = realSetInterval
    ;(globalThis as unknown as { clearInterval: unknown }).clearInterval = realClearInterval
  }
})

test('uses one host scan for multiple subscribers and separates snapshots from notifications', async () => {
  let scanCount = 0
  let states = [pane('local:%1'), pane('local:%2')]
  const eventsA: AgentMonitorEvent[] = []
  const eventsB: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => {
      scanCount += 1
      return states
    },
    intervalMs: 1000,
  })
  const unsubscribeA = monitor.subscribe((event) => eventsA.push(event))
  const unsubscribeB = monitor.subscribe((event) => eventsB.push(event))
  await monitor.start()
  assert.equal(scanCount, 1)
  assert.equal(eventsA.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(eventsB.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(
    eventsA.some((event) => event.type === 'agent_notification'),
    false,
  )
  assert.deepEqual(
    monitor.getStates('local')?.map((item) => item.paneId),
    ['local:%1', 'local:%2'],
  )
  states = [pane('local:%1', 'failed', 'failed'), pane('local:%2')]
  await monitor.pollNow('local')
  assert.equal(eventsA.filter((event) => event.type === 'agent_notification').length, 1)
  assert.equal(eventsB.filter((event) => event.type === 'agent_notification').length, 1)
  assert.equal(monitor.getStates('local')?.find((item) => item.paneId === 'local:%2')?.phase, 'working')
  unsubscribeA()
  unsubscribeB()
  monitor.stop()
})

test('publishes removed panes and does not convert a scan failure into completion', async () => {
  let fail = false
  let states: AgentPaneState[] = [pane('local:%1')]
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => {
      if (fail) throw new Error('tmux unavailable')
      return states
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  fail = true
  await monitor.pollNow('local')
  assert.equal(
    events.some((event) => event.type === 'agent_status_changed' && event.pane?.lastEvent === 'completed'),
    false,
  )
  assert.equal(
    events.some((event) => event.type === 'agent_status_changed' && event.pane?.phase === 'disconnected'),
    true,
  )
  fail = false
  states = []
  await monitor.pollNow('local')
  const removed = events.find((event) => event.type === 'agent_status_removed')
  assert.equal(removed?.paneId, 'local:%1')
  unsubscribe()
  monitor.stop()
})

test('emits a disconnected notification once and a reconnected change after recovery', async () => {
  let fail = false
  const states: AgentPaneState[] = [pane('local:%2')]
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => {
      if (fail) throw new Error('offline')
      return states
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  fail = true
  await monitor.pollNow('local')
  await monitor.pollNow('local')
  assert.equal(
    events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'disconnected').length,
    1,
  )
  fail = false
  await monitor.pollNow('local')
  assert.equal(
    events.some((event) => event.type === 'agent_status_changed' && event.pane?.lastEvent === 'reconnected'),
    true,
  )
  unsubscribe()
  monitor.stop()
})

test('throttles repeated notifications for the same pane and stage', async () => {
  let now = 1000000
  let states: AgentPaneState[] = [pane('local:%1')]
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
    now: () => now,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  const failedPane = (revision: number) => ({
    ...pane('local:%1', 'failed', 'failed'),
    revision,
    eventId: 'local:%1:failed:' + revision,
  })
  const workingPane = (revision: number) => ({ ...pane('local:%1'), revision, eventId: 'local:%1:started:' + revision })
  states = [failedPane(2)]
  await monitor.pollNow('local')
  states = [workingPane(3)]
  await monitor.pollNow('local')
  states = [failedPane(4)]
  await monitor.pollNow('local')
  assert.equal(
    events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length,
    1,
  )
  now += 31000
  states = [workingPane(5)]
  await monitor.pollNow('local')
  states = [failedPane(6)]
  await monitor.pollNow('local')
  assert.equal(
    events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length,
    2,
  )
  unsubscribe()
  monitor.stop()
})
test('clears the notification throttle when the pane is removed', async () => {
  const now = 1000000
  let states: AgentPaneState[] = [
    { ...pane('local:%1', 'failed', 'failed'), revision: 2, eventId: 'local:%1:failed:2' },
  ]
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
    now: () => now,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  states = [{ ...pane('local:%1', 'failed', 'failed'), revision: 3, eventId: 'local:%1:failed:3' }]
  await monitor.pollNow('local')
  states = []
  await monitor.pollNow('local')
  states = [{ ...pane('local:%1', 'failed', 'failed'), revision: 4, eventId: 'local:%1:failed:4' }]
  await monitor.pollNow('local')
  assert.equal(
    events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length,
    2,
  )
  unsubscribe()
  monitor.stop()
})
test('keeps local, ssh, and agent hosts as independent monitor keys', async () => {
  const scanned: string[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local', 'ssh-host', 'agent-host'],
    scan: async (hostId) => {
      scanned.push(hostId)
      return [pane(hostId + ':%1')]
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  assert.deepEqual(scanned.sort(), ['agent-host', 'local', 'ssh-host'])
  assert.equal(monitor.getStates('local')?.[0]?.paneId, 'local:%1')
  assert.equal(monitor.getStates('ssh-host')?.[0]?.paneId, 'ssh-host:%1')
  assert.equal(monitor.getStates('agent-host')?.[0]?.paneId, 'agent-host:%1')
  unsubscribe()
  monitor.stop()
})

test('removes deleted sessions and hosts without affecting other monitor state', async () => {
  let hostIds = ['local', 'remote']
  let states: Record<string, AgentPaneState[]> = {
    local: [pane('local:%1')],
    remote: [pane('remote:%2')],
  }
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => hostIds,
    scan: async (hostId) => states[hostId] || [],
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  states = { local: [], remote: [pane('remote:%2')] }
  await monitor.pollNow('local')
  assert.equal(findRemoved(events, 'local:%1')?.reason, 'pane_exited')
  assert.deepEqual(
    monitor.getStates('remote')?.map((item) => item.paneId),
    ['remote:%2'],
  )
  hostIds = ['local']
  await callRefreshHosts(monitor, false)
  assert.equal(findRemoved(events, 'remote:%2')?.reason, 'host_removed')
  assert.equal(monitor.getStates('remote'), null)
  unsubscribe()
  monitor.stop()
})

test('applies display metadata patches with seq dedup and ttl expiry', async () => {
  const states: AgentPaneState[] = [pane('local:%5')]
  const events: AgentMonitorEvent[] = []
  let now = 5000
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
    now: () => now,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  const displayEvent = (seq: number, title: string, ttlMs = 60000, at = now) => ({
    hostId: 'local',
    agent: 'codex',
    paneId: 'local:%5',
    tmuxPaneId: '%5',
    sessionName: 'dev',
    agentSessionId: 'local:%5:dev',
    type: 'working' as const,
    phase: 'working' as const,
    lastEvent: 'started' as const,
    source: 'protocol' as const,
    confidence: 'high' as const,
    eventId: 'local:codex:display:' + seq,
    timestamp: new Date(at).toISOString(),
    display: { title, seq, ttlMs },
  })
  monitor.ingestProtocolEvent(displayEvent(1, 'First'))
  now = 6000
  monitor.ingestProtocolEvent(displayEvent(3, 'Third'))
  now = 7000
  monitor.ingestProtocolEvent(displayEvent(2, 'Stale'))
  let current = monitor.getStates('local')?.find((item) => item.paneId === 'local:%5')
  assert.equal(current?.display?.title, 'Third')
  assert.equal(current?.display?.seq, 3)
  await monitor.pollNow('local')
  current = monitor.getStates('local')?.find((item) => item.paneId === 'local:%5')
  assert.equal(current?.display?.title, 'Third')
  now = 9000
  monitor.ingestProtocolEvent(displayEvent(4, 'Expiring', 1000, now))
  await monitor.pollNow('local')
  current = monitor.getStates('local')?.find((item) => item.paneId === 'local:%5')
  assert.equal(current?.display?.title, 'Expiring')
  now = 11000
  await monitor.pollNow('local')
  current = monitor.getStates('local')?.find((item) => item.paneId === 'local:%5')
  assert.equal(current?.display, undefined)
  monitor.stop()
  unsubscribe()
})

test('scopes display seq dedup per source and keeps legacy unsourced patches compatible', async () => {
  const states: AgentPaneState[] = [pane('local:%5')]
  let now = 5000
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
    now: () => now,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  const displayEvent = (source: string | undefined, seq: number, title: string) => {
    now += 1000
    return {
      hostId: 'local',
      agent: 'codex',
      paneId: 'local:%5',
      tmuxPaneId: '%5',
      sessionName: 'dev',
      agentSessionId: 'local:%5:dev',
      type: 'working' as const,
      phase: 'working' as const,
      lastEvent: 'started' as const,
      source: 'protocol' as const,
      confidence: 'high' as const,
      eventId: 'local:codex:display:' + (source || 'flat') + ':' + seq,
      timestamp: new Date(now).toISOString(),
      display: { title, seq, ttlMs: 60000, ...(source ? { source } : {}) },
    }
  }
  const currentDisplay = () => monitor.getStates('local')?.find((item) => item.paneId === 'local:%5')?.display
  monitor.ingestProtocolEvent(displayEvent('tui', 5, 'TUI five'))
  monitor.ingestProtocolEvent(displayEvent('hook-feed', 2, 'Hook two'))
  assert.equal(currentDisplay()?.title, 'Hook two')
  assert.equal(currentDisplay()?.source, 'hook-feed')
  monitor.ingestProtocolEvent(displayEvent('tui', 4, 'TUI stale'))
  assert.equal(currentDisplay()?.title, 'Hook two')
  monitor.ingestProtocolEvent(displayEvent('tui', 6, 'TUI six'))
  assert.equal(currentDisplay()?.title, 'TUI six')
  assert.equal(currentDisplay()?.source, 'tui')
  monitor.ingestProtocolEvent(displayEvent('hook-feed', 1, 'Hook stale'))
  assert.equal(currentDisplay()?.title, 'TUI six')
  monitor.ingestProtocolEvent(displayEvent(undefined, 2, 'Legacy two'))
  assert.equal(currentDisplay()?.title, 'Legacy two')
  assert.equal(currentDisplay()?.source, undefined)
  monitor.ingestProtocolEvent(displayEvent(undefined, 1, 'Legacy stale'))
  assert.equal(currentDisplay()?.title, 'Legacy two')
  monitor.ingestProtocolEvent(displayEvent('tui', 7, 'TUI seven'))
  assert.equal(currentDisplay()?.title, 'TUI seven')
  monitor.stop()
  unsubscribe()
})

test('idle cadence uses the push tier while web-push subscribers exist', async () => {
  let hasPush = false
  const monitor = new AgentMonitor({
    scan: async () => [],
    getHostIds: async () => ['local'],
    intervalMs: 250,
    pushPollMs: 5000,
    idleMs: 30000,
    // 注入 push 探测避免依赖真实通知存储；启动时也会做一次只读探测，故与 options 同源
    hasPushSubscribers: () => hasPush,
  })
  const currentPollMs = () => (monitor as unknown as { currentPollMs: () => number }).currentPollMs()
  // 三档：无监听无 push → 怠速；有 push → 5s 折中；有监听者 → 快档
  assert.equal(currentPollMs(), 30000)
  // 必须先等 start 落地再断言，否则 stop() 早于定时器创建会留下 interval 把进程挂住
  await monitor.start()
  hasPush = true
  assert.equal(currentPollMs(), 5000)
  const unsubscribe = monitor.subscribe(() => {})
  assert.equal(currentPollMs(), 250)
  unsubscribe()
  assert.equal(currentPollMs(), 5000)
  monitor.stop()
})

test('stamps stateSeq once and only advances it on real state changes', async () => {
  let states: AgentPaneState[] = [pane('local:%6')]
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  const first = monitor.getStates('local')?.[0]?.stateSeq
  assert.ok(first !== undefined && first > 0)
  await monitor.pollNow('local')
  assert.equal(monitor.getStates('local')?.[0]?.stateSeq, first)
  states = [pane('local:%6', 'failed', 'failed')]
  await monitor.pollNow('local')
  const second = monitor.getStates('local')?.[0]?.stateSeq
  assert.ok(second !== undefined && second > first)
  unsubscribe()
  monitor.stop()
})

test('discards an in-flight scan after stop and emits a fresh snapshot after restart', async () => {
  let releaseScan: (states: AgentPaneState[]) => void = () => {}
  let scanCount = 0
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => {
      scanCount += 1
      if (scanCount === 1)
        return new Promise<AgentPaneState[]>((resolve) => {
          releaseScan = resolve
        })
      return [pane('local:%3')]
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  const started = monitor.start()
  await new Promise((resolve) => setImmediate(resolve))
  monitor.stop()
  releaseScan([pane('local:%3')])
  await started
  assert.equal(
    events.some((event) => event.type === 'agent_status_snapshot'),
    false,
  )
  await monitor.start()
  assert.equal(events.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(
    events.some((event) => event.type === 'agent_notification'),
    false,
  )
  unsubscribe()
  monitor.stop()
})

test('publishes the first snapshot after an initially unavailable host recovers', async () => {
  let fail = true
  const events: AgentMonitorEvent[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => {
      if (fail) throw new Error('offline')
      return [pane('local:%4')]
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  assert.equal(
    events.some((event) => event.type === 'agent_status_snapshot'),
    false,
  )
  fail = false
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(
    events.some((event) => event.type === 'agent_notification'),
    false,
  )
  unsubscribe()
  monitor.stop()
})

test('records recovery candidates on pane removal, ended transitions and host removal', async () => {
  const seen: RecoveryCandidateInput[] = []
  let states: AgentPaneState[] = [
    { ...pane('local:%7'), nativeAgentSessionId: 'claude-sess-1', cwd: '/repo' },
    pane('local:%8'),
  ]
  let hostIds = ['local']
  const monitor = new AgentMonitor({
    getHostIds: async () => hostIds,
    scan: async () => states,
    intervalMs: 1000,
    onRecoveryCandidate: (candidate) => seen.push(candidate),
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  // pane 移除：nativeAgentSessionId/cwd 原样进入候选，scan 合成 id 不落盘
  states = [pane('local:%8')]
  await monitor.pollNow('local')
  const removed = seen.find((item) => item.paneId === 'local:%7')
  assert.equal(removed?.reason, 'pane_exited')
  assert.equal(removed?.agentSessionId, 'claude-sess-1')
  assert.equal(removed?.cwd, '/repo')
  // agent 进程在 pane 内结束（协议 session_ended）→ 同 pane 记候选
  monitor.ingestProtocolEvent({
    hostId: 'local',
    agent: 'codex',
    paneId: 'local:%8',
    tmuxPaneId: '%8',
    sessionName: 'dev',
    agentSessionId: 'thread-99',
    type: 'session_ended',
    phase: 'ended',
    lastEvent: 'ended',
    source: 'protocol',
    confidence: 'high',
    eventId: 'local:codex:end:1',
    timestamp: new Date().toISOString(),
  })
  const ended = seen.find((item) => item.paneId === 'local:%8' && item.reason === 'process_exited')
  assert.equal(ended?.agentSessionId, 'thread-99')
  // host 下线 → 全部 pane 记 host_removed
  hostIds = []
  await callRefreshHosts(monitor)
  assert.ok(seen.filter((item) => item.reason === 'host_removed').length >= 1)
  unsubscribe()
  monitor.stop()
})

test('nativeAgentSessionId comes only from protocol events and survives scan refresh', async () => {
  const states: AgentPaneState[] = [pane('local:%9')]
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
    onRecoveryCandidate: () => {},
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  const current = () => monitor.getStates('local')?.find((item) => item.paneId === 'local:%9')
  assert.equal(current()?.nativeAgentSessionId, undefined)
  monitor.ingestProtocolEvent({
    hostId: 'local',
    agent: 'codex',
    paneId: 'local:%9',
    sessionName: 'dev',
    agentSessionId: 'native-thread-42',
    type: 'working',
    phase: 'working',
    lastEvent: 'started',
    source: 'protocol',
    confidence: 'high',
    eventId: 'local:codex:native:1',
    timestamp: new Date().toISOString(),
  })
  assert.equal(current()?.nativeAgentSessionId, 'native-thread-42')
  await monitor.pollNow('local')
  assert.equal(current()?.nativeAgentSessionId, 'native-thread-42')
  monitor.stop()
  unsubscribe()
})

// markSeen 需清掉该 pane 仍挂着的 completed 协议覆盖：不清则 TTL 内的旧事件
// 在下一次 scan 时重新叠回 done，「标记已读」立刻失效
test('markSeen clears stale completed protocol overlay so done does not reapply', async () => {
  const states: AgentPaneState[] = [pane('local:%7')]
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => states,
    intervalMs: 1000,
  })
  const events: AgentMonitorEvent[] = []
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  monitor.ingestProtocolEvent({
    hostId: 'local',
    agent: 'codex',
    paneId: 'local:%7',
    tmuxPaneId: '%7',
    sessionName: 'dev',
    agentSessionId: 'local:%7:dev',
    type: 'idle',
    phase: 'idle',
    lastEvent: 'completed',
    source: 'protocol',
    confidence: 'high',
    eventId: 'local:codex:done:1',
    timestamp: new Date().toISOString(),
  })
  const current = () => monitor.getStates('local')?.find((item) => item.paneId === 'local:%7')
  assert.equal(current()?.agentStatus, 'done')
  const marked = monitor.markSeen('local:%7')
  assert.equal(marked?.agentStatus, 'idle')
  assert.equal(current()?.agentStatus, 'idle')
  // 无记录的路径下 scan 仍报 working：清掉的覆盖不再回贴，状态回到真实 working
  await monitor.pollNow('local')
  assert.equal(current()?.agentStatus, 'working')
  monitor.stop()
  unsubscribe()
})

// 空扫退避：远端纯 ssh 主机永远扫出空集，不该每拍都白开一条 ssh；扫到东西要立刻回满档
test('backs off scan cadence on empty remote hosts and restores it on the first pane', async () => {
  let states: AgentPaneState[] = []
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => states,
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  // 首扫为空：还没到阶梯（2 轮），间隔仍是满档
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  await monitor.pollNow('edge')
  // 第 2 轮仍空 → 降到 15s 档
  assert.equal(monitor.getPollIntervalMs('edge'), 15_000)
  await monitor.pollNow('edge')
  states = [pane('edge:%1')]
  await monitor.pollNow('edge')
  // 扫到 pane → 立刻回满档
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  unsubscribe()
  monitor.stop()
})

test('does not count a scan failure as an empty round', async () => {
  let fail = false
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => {
      if (fail) throw new Error('ssh failed')
      return []
    },
    intervalMs: 1000,
  })
  // 订阅后才是满档（1000）；无监听者时基线本来就是 30s 怠速档，退避无从叠加
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  await monitor.pollNow('edge')
  // 两轮空已经降到 15s 档
  assert.equal(monitor.getPollIntervalMs('edge'), 15_000)
  fail = true
  await monitor.pollNow('edge')
  // 出错要按满频重试，不能借退避把故障主机藏起来
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  fail = false
  await monitor.pollNow('edge')
  // 出错已把计数清零：这一轮只是「第 1 轮空」，还没到阶梯
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  unsubscribe()
  monitor.stop()
})

test('never backs off the local host even after many empty scans', async () => {
  const monitor = new AgentMonitor({
    getHostIds: async () => ['local'],
    scan: async () => [],
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  for (let i = 0; i < 6; i += 1) await monitor.pollNow('local')
  // local 的扫描只是一次 tmux execFile，退避没有收益还会拖慢本机可观测性
  assert.equal(monitor.getPollIntervalMs('local'), 1000)
  unsubscribe()
  monitor.stop()
})

test('empty scan backoff ladder is ordered from slowest tier down', () => {
  assert.equal(emptyScanBackoffMs(0), 0)
  assert.equal(emptyScanBackoffMs(1), 0)
  assert.equal(emptyScanBackoffMs(2), 15_000)
  assert.equal(emptyScanBackoffMs(4), 15_000)
  assert.equal(emptyScanBackoffMs(5), 60_000)
  assert.equal(emptyScanBackoffMs(8), 120_000)
  assert.equal(emptyScanBackoffMs(99), 120_000)
})

// 只看 getPollIntervalMs 不够：退避必须真的挂到定时器上，否则空扫降压只是账面数字
test('re-arms the host timer at the backed-off cadence after an empty scan', async () => {
  const armed: number[] = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  ;(globalThis as unknown as { setInterval: unknown }).setInterval = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    armed.push(ms ?? 0)
    return (realSetInterval as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest)
  }) as unknown as typeof setInterval
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => [],
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  try {
    await monitor.start()
    await monitor.pollNow('edge')
    // 第 2 轮空扫后必须出现一条 15s 档的定时器（而不是继续用旧的 1s 表）
    assert.equal(armed.includes(15_000), true, `实际挂表档位: ${armed.join(',')}`)
  } finally {
    unsubscribe()
    monitor.stop()
    ;(globalThis as unknown as { setInterval: unknown }).setInterval = realSetInterval
    ;(globalThis as unknown as { clearInterval: unknown }).clearInterval = realClearInterval
  }
})

// 唤醒通道：终端 attach / agent 事件进站说明该 host 可能有 agent 刚起来，
// 不能等 120s 的退避档到期才发现
test('noteHostActivity clears the empty-scan tier and scans immediately', async () => {
  let scanCount = 0
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => {
      scanCount += 1
      return []
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  await monitor.pollNow('edge')
  // 两轮空已降到 15s 档，此刻仍在档位上
  assert.equal(monitor.getPollIntervalMs('edge'), 15_000)
  const before = scanCount
  monitor.noteHostActivity('edge')
  // 立即排扫：不等定时器
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(scanCount, before + 1)
  // 档位回到满档（这一轮仍扫出空，只说明「重新从第 0 轮计」，不是保证扫到）
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  unsubscribe()
  monitor.stop()
})

test('a protocol event from a backed-off host wakes the scan and re-arms the fast tier', async () => {
  let scanCount = 0
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => {
      scanCount += 1
      return []
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  await monitor.pollNow('edge')
  assert.equal(monitor.getPollIntervalMs('edge'), 15_000)
  const before = scanCount
  monitor.ingestProtocolEvent({
    hostId: 'edge',
    eventId: 'event-1',
    paneId: 'edge:%1',
    tmuxPaneId: '%1',
    sessionName: 'dev',
    agent: 'codex',
    kind: 'state',
    state: 'working',
    timestamp: new Date().toISOString(),
  } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 唤醒不依赖事件能否匹配到已知 pane
  assert.equal(scanCount, before + 1)
  assert.equal(monitor.getPollIntervalMs('edge'), 1000)
  unsubscribe()
  monitor.stop()
})

test('noteHostActivity on an untracked or stopped host is a no-op', async () => {
  let scanCount = 0
  const monitor = new AgentMonitor({
    getHostIds: async () => ['edge'],
    scan: async () => {
      scanCount += 1
      return []
    },
    intervalMs: 1000,
  })
  const unsubscribe = monitor.subscribe(() => {})
  await monitor.start()
  const before = scanCount
  monitor.noteHostActivity('ghost')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(scanCount, before)
  unsubscribe()
  monitor.stop()
  // stop 之后唤醒不能把扫描重新拉起来
  monitor.noteHostActivity('edge')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(scanCount, before)
})
