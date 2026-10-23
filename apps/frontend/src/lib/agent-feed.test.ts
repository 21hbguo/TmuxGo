import { describe, expect, it, vi } from 'vitest'
import { AgentFeedClient, AGENT_FEED_RESYNC_MAX, AGENT_PROTO_VERSION, isAgentStateFrame } from './agent-feed'
import type { AgentFeedUpdate, AgentStateFrame } from './agent-feed'
import type { AgentPaneState } from '@/types'

function pane(
  paneId: string,
  stateSeq: number,
  agentStatus: AgentPaneState['agentStatus'] = 'working',
): AgentPaneState {
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
function frame(overrides: Partial<AgentStateFrame> = {}): AgentStateFrame {
  return {
    type: 'agent_state',
    subId: 'as_1',
    hostId: 'local',
    mode: 'full',
    seq: 1,
    stateSeq: 3,
    changed: [pane('local:%1', 3)],
    removed: [],
    ...overrides,
  }
}
function createClient(options: { sendOk?: boolean } = {}) {
  const sent: Record<string, unknown>[] = []
  const updates: AgentFeedUpdate[] = []
  const degraded: string[] = []
  let sendOk = options.sendOk !== false
  const client = new AgentFeedClient({
    send: (payload) => {
      sent.push(payload)
      return sendOk
    },
    onUpdate: (update) => updates.push(update),
    onDegraded: (hostId) => degraded.push(hostId),
  })
  return {
    client,
    sent,
    updates,
    degraded,
    setSendOk: (value: boolean) => {
      sendOk = value
    },
  }
}

describe('agent feed client', () => {
  it('subscribes per host and retracts the subscription when the socket is not ready', () => {
    const { client, sent, setSendOk } = createClient({ sendOk: false })
    client.subscribe('local')
    expect(sent[0]).toMatchObject({
      type: 'agent_subscribe',
      agentProtoVersion: AGENT_PROTO_VERSION,
      hostId: 'local',
      needFull: true,
      wantNotifications: true,
    })
    // send 失败说明订阅没发出去：不能留下收不到帧的幽灵订阅
    expect(client.has('local')).toBe(false)
    setSendOk(true)
    client.subscribe('local')
    expect(client.has('local')).toBe(true)
    client.subscribe('local')
    expect(sent).toHaveLength(2)
  })

  it('applies the first full frame and then deltas in seq order', () => {
    const { client, updates } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    client.handleFrame(frame({ mode: 'delta', seq: 2, stateSeq: 4, changed: [pane('local:%2', 4, 'done')] }))
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ mode: 'full', hostId: 'local', stateSeq: 3 })
    expect(updates[1].mode).toBe('delta')
    expect(updates[1].changed.map((item) => item.paneId)).toEqual(['local:%2'])
  })

  it('ignores duplicate and stale seq frames', () => {
    const { client, updates } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    client.handleFrame(frame({ mode: 'delta', seq: 1, stateSeq: 99 }))
    client.handleFrame(frame({ mode: 'delta', seq: 2, stateSeq: 4 }))
    client.handleFrame(frame({ mode: 'delta', seq: 2, stateSeq: 5 }))
    expect(updates.map((update) => update.mode)).toEqual(['full', 'delta'])
    expect(client.getStateSeq('local')).toBe(4)
  })

  it('asks for a resync on a seq gap and keeps the old watermark', () => {
    const { client, sent, updates } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    client.handleFrame(frame({ mode: 'delta', seq: 3, stateSeq: 9 }))
    expect(sent.at(-1)).toEqual({ type: 'agent_resync', subId: 'as_1' })
    // 断号帧不落地：跳过它，等 full 重放
    expect(updates).toHaveLength(1)
    expect(client.getStateSeq('local')).toBe(3)
    // 重放的 full 必然跳号（服务端发帧时已自增）：full 一律当基线接受
    client.handleFrame(frame({ mode: 'full', seq: 7, stateSeq: 5 }))
    expect(updates.at(-1)?.mode).toBe('full')
    expect(client.getStateSeq('local')).toBe(5)
    // 之后 delta 从新的基线续上
    client.handleFrame(frame({ mode: 'delta', seq: 8, stateSeq: 6 }))
    expect(updates.at(-1)?.stateSeq).toBe(6)
  })

  it('degrades to REST after exhausting resync attempts', () => {
    const { client, sent, degraded } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    const resyncs = sent.filter((payload) => payload.type === 'agent_resync').length
    expect(resyncs).toBe(0)
    for (let attempt = 0; attempt < AGENT_FEED_RESYNC_MAX + 1; attempt += 1) {
      client.handleFrame(frame({ mode: 'delta', seq: 10 + attempt, stateSeq: 20 }))
    }
    expect(sent.filter((payload) => payload.type === 'agent_resync')).toHaveLength(AGENT_FEED_RESYNC_MAX)
    expect(degraded).toEqual(['local'])
    expect(client.has('local')).toBe(false)
  })

  it('treats pulse as watermark only and ignores frames from an older subscription', () => {
    const { client, updates } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    client.handleFrame(frame({ mode: 'pulse', seq: 2, stateSeq: 42, changed: [] }))
    expect(updates).toHaveLength(1)
    expect(client.getStateSeq('local')).toBe(42)
    // 重订过渡期的旧 subId 残帧不得被当成新订阅的数据
    client.handleFrame(frame({ subId: 'as_old', mode: 'full', seq: 3, stateSeq: 50 }))
    expect(updates).toHaveLength(1)
  })

  it('drops frames for hosts that are not subscribed and resubscribes after reset', () => {
    const { client, sent, updates } = createClient()
    client.subscribe('local')
    client.handleFrame(frame({ hostId: 'remote' }))
    expect(updates).toHaveLength(0)
    client.reset()
    expect(client.size).toBe(0)
    // reset 后 seq 从头算，服务端新订阅也从 1 开始
    client.subscribe('local')
    client.handleFrame(frame({ subId: 'as_2', seq: 1 }))
    expect(updates).toHaveLength(1)
    expect(client.getSubId('local')).toBe('as_2')
    expect(sent.filter((payload) => payload.type === 'agent_subscribe')).toHaveLength(2)
  })

  it('unsubscribes with the server subId and clears the rest of the sequence state', () => {
    const { client, sent } = createClient()
    client.subscribe('local')
    client.handleFrame(frame())
    client.unsubscribe('local')
    client.handleFrame(frame({ mode: 'delta', seq: 2 }))
    expect(sent.at(-1)).toEqual({ type: 'agent_unsubscribe', subId: 'as_1' })
    expect(client.hosts()).toEqual([])
  })
})

describe('isAgentStateFrame', () => {
  it('accepts v1 frames and rejects everything else', () => {
    expect(isAgentStateFrame(frame())).toBe(true)
    expect(isAgentStateFrame({ ...frame(), mode: 'weird' })).toBe(false)
    expect(isAgentStateFrame({ ...frame(), subId: undefined })).toBe(false)
    expect(isAgentStateFrame({ type: 'agent_status_changed', hostId: 'local' })).toBe(false)
    expect(isAgentStateFrame(null)).toBe(false)
    expect(isAgentStateFrame('agent_state')).toBe(false)
  })
})

// 保留引用避免未使用告警：vi 在部分测试文件里用于 fake timers 的清理
void vi
