import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentMonitor } from './agent-monitor.js'
import type { AgentPaneState } from './agent-state.js'

function pane(paneId: string, phase: AgentPaneState['phase'] = 'working', lastEvent: AgentPaneState['lastEvent'] = 'started'): AgentPaneState {
  return { paneId, tmuxPaneId: paneId.slice(paneId.indexOf(':') + 1), sessionName: 'dev', agent: 'codex', agentSessionId: paneId + ':dev', agentStatus: phase === 'working' ? 'working' : phase === 'idle' ? 'idle' : phase === 'failed' ? 'unknown' : 'blocked', phase, lastEvent, source: 'process', confidence: 'medium', since: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:01.000Z', eventId: paneId + ':' + (lastEvent || 'state'), revision: 1 }
}

test('uses one host scan for multiple subscribers and separates snapshots from notifications', async () => {
  let scanCount = 0
  let states = [pane('local:%1'), pane('local:%2')]
  const eventsA: any[] = []
  const eventsB: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => { scanCount += 1; return states }, intervalMs: 1000 })
  const unsubscribeA = monitor.subscribe((event) => eventsA.push(event))
  const unsubscribeB = monitor.subscribe((event) => eventsB.push(event))
  await monitor.start()
  assert.equal(scanCount, 1)
  assert.equal(eventsA.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(eventsB.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(eventsA.some((event) => event.type === 'agent_notification'), false)
  assert.deepEqual(monitor.getStates('local')?.map((item) => item.paneId), ['local:%1', 'local:%2'])
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
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => { if (fail) throw new Error('tmux unavailable'); return states }, intervalMs: 1000 })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  fail = true
  await monitor.pollNow('local')
  assert.equal(events.some((event) => event.type === 'agent_status_changed' && event.pane?.lastEvent === 'completed'), false)
  assert.equal(events.some((event) => event.type === 'agent_status_changed' && event.pane?.phase === 'disconnected'), true)
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
  let states: AgentPaneState[] = [pane('local:%2')]
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => { if (fail) throw new Error('offline'); return states }, intervalMs: 1000 })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  fail = true
  await monitor.pollNow('local')
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'disconnected').length, 1)
  fail = false
  await monitor.pollNow('local')
  assert.equal(events.some((event) => event.type === 'agent_status_changed' && event.pane?.lastEvent === 'reconnected'), true)
  unsubscribe()
  monitor.stop()
})

test('throttles repeated notifications for the same pane and stage', async () => {
  let now = 1000000
  let states: AgentPaneState[] = [pane('local:%1')]
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => states, intervalMs: 1000, now: () => now })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  const failedPane = (revision: number) => ({ ...pane('local:%1', 'failed', 'failed'), revision, eventId: 'local:%1:failed:' + revision })
  const workingPane = (revision: number) => ({ ...pane('local:%1'), revision, eventId: 'local:%1:started:' + revision })
  states = [failedPane(2)]
  await monitor.pollNow('local')
  states = [workingPane(3)]
  await monitor.pollNow('local')
  states = [failedPane(4)]
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length, 1)
  now += 31000
  states = [workingPane(5)]
  await monitor.pollNow('local')
  states = [failedPane(6)]
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length, 2)
  unsubscribe()
  monitor.stop()
})
test('clears the notification throttle when the pane is removed', async () => {
  let now = 1000000
  let states: AgentPaneState[] = [{ ...pane('local:%1', 'failed', 'failed'), revision: 2, eventId: 'local:%1:failed:2' }]
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => states, intervalMs: 1000, now: () => now })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  states = [{ ...pane('local:%1', 'failed', 'failed'), revision: 3, eventId: 'local:%1:failed:3' }]
  await monitor.pollNow('local')
  states = []
  await monitor.pollNow('local')
  states = [{ ...pane('local:%1', 'failed', 'failed'), revision: 4, eventId: 'local:%1:failed:4' }]
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_notification' && event.pane?.lastEvent === 'failed').length, 2)
  unsubscribe()
  monitor.stop()
})
test('keeps local, ssh, and agent hosts as independent monitor keys', async () => {
  const scanned: string[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local', 'ssh-host', 'agent-host'], scan: async (hostId) => { scanned.push(hostId); return [pane(hostId + ':%1')] }, intervalMs: 1000 })
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
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => hostIds, scan: async (hostId) => states[hostId] || [], intervalMs: 1000 })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  states = { local: [], remote: [pane('remote:%2')] }
  await monitor.pollNow('local')
  assert.equal(events.find((event) => event.type === 'agent_status_removed' && event.paneId === 'local:%1')?.reason, 'pane_exited')
  assert.deepEqual(monitor.getStates('remote')?.map((item) => item.paneId), ['remote:%2'])
  hostIds = ['local']
  await (monitor as any).refreshHosts(false)
  assert.equal(events.find((event) => event.type === 'agent_status_removed' && event.paneId === 'remote:%2')?.reason, 'host_removed')
  assert.equal(monitor.getStates('remote'), null)
  unsubscribe()
  monitor.stop()
})

test('applies display metadata patches with seq dedup and ttl expiry', async () => {
  let states: AgentPaneState[] = [pane('local:%5')]
  const events: any[] = []
  let now = 5000
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => states, intervalMs: 1000, now: () => now })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  const displayEvent = (seq: number, title: string, ttlMs = 60000, at = now) => ({
    hostId: 'local', agent: 'codex', paneId: 'local:%5', tmuxPaneId: '%5', sessionName: 'dev', agentSessionId: 'local:%5:dev',
    type: 'working' as const, phase: 'working' as const, lastEvent: 'started' as const, source: 'protocol' as const, confidence: 'high' as const,
    eventId: 'local:codex:display:' + seq, timestamp: new Date(at).toISOString(), display: { title, seq, ttlMs },
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

test('discards an in-flight scan after stop and emits a fresh snapshot after restart', async () => {
  let releaseScan: (states: AgentPaneState[]) => void = () => {}
  let scanCount = 0
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => {
    scanCount += 1
    if (scanCount === 1) return new Promise<AgentPaneState[]>((resolve) => { releaseScan = resolve })
    return [pane('local:%3')]
  }, intervalMs: 1000 })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  const started = monitor.start()
  await new Promise((resolve) => setImmediate(resolve))
  monitor.stop()
  releaseScan([pane('local:%3')])
  await started
  assert.equal(events.some((event) => event.type === 'agent_status_snapshot'), false)
  await monitor.start()
  assert.equal(events.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(events.some((event) => event.type === 'agent_notification'), false)
  unsubscribe()
  monitor.stop()
})

test('publishes the first snapshot after an initially unavailable host recovers', async () => {
  let fail = true
  const events: any[] = []
  const monitor = new AgentMonitor({ getHostIds: async () => ['local'], scan: async () => { if (fail) throw new Error('offline'); return [pane('local:%4')] }, intervalMs: 1000 })
  const unsubscribe = monitor.subscribe((event) => events.push(event))
  await monitor.start()
  assert.equal(events.some((event) => event.type === 'agent_status_snapshot'), false)
  fail = false
  await monitor.pollNow('local')
  assert.equal(events.filter((event) => event.type === 'agent_status_snapshot').length, 1)
  assert.equal(events.some((event) => event.type === 'agent_notification'), false)
  unsubscribe()
  monitor.stop()
})
