/**
 * 尺寸协议字段（requestId/windowVersion/ownerEpoch）回归测试。
 * 向后兼容的可选扩展：version/epoch 由网关按会话级计数表生成，requestId
 * 原样回声；前端据单调序号丢弃跨所有权世代或乱序到达的旧尺寸事件与 ACK。
 */
import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { claimExclusiveOwnership, resetExclusiveOwnershipForTest, StreamSession } from './stream-session.js'
import { streamResizeMessageSchema } from '../request-validation.js'
import { RESIZE_ACK_OUTPUT_WAIT_MS } from './stream-config.js'

function createSession(cols = 120, rows = 36) {
  const sent: any[] = []
  const resized: Array<[number, number]> = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer) {
      sent.push(JSON.parse(String(data)))
    },
    close() {},
  }
  const session = new StreamSession(socket, null)
  session.attachedSessionName = 'dev'
  session.attachedHostId = 'local'
  session.attachedCols = cols
  session.attachedRows = rows
  session.ptyProcess = {
    pid: 1,
    resize: (c: number, r: number) => resized.push([c, r]),
    write: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  } as any
  return { session, sent, resized }
}

function mockPty() {
  return { pid: 2, resize: () => {}, write: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} } as any
}

test('resize schema accepts optional requestId, stays backward compatible', () => {
  const bare = streamResizeMessageSchema.parse({ type: 'resize', cols: 100, rows: 30 })
  assert.equal(bare.requestId, undefined)
  const str = streamResizeMessageSchema.parse({ type: 'resize', cols: 100, rows: 30, requestId: 'r-1' })
  assert.equal(str.requestId, 'r-1')
  const num = streamResizeMessageSchema.parse({ type: 'resize', cols: 100, rows: 30, requestId: 7 })
  assert.equal(num.requestId, 7)
  // 超长字符串不静默截断，直接拒收
  assert.throws(() => streamResizeMessageSchema.parse({ type: 'resize', cols: 1, rows: 1, requestId: 'x'.repeat(200) }))
})

test('resized ack echoes requestId with windowVersion and ownerEpoch', async () => {
  resetExclusiveOwnershipForTest()
  const { session, sent } = createSession()
  session.attachedExclusive = true
  claimExclusiveOwnership(session)
  ;(session as any).refreshAttachedClient = async () => {}
  session.resize(100, 40, 'req-42')
  await new Promise((r) => setTimeout(r, RESIZE_ACK_OUTPUT_WAIT_MS + 80))
  const ack = sent.find((m) => m.type === 'resized')
  assert.equal(ack.requestId, 'req-42')
  assert.equal(ack.windowVersion, 1)
  assert.equal(ack.ownerEpoch, session.ownerEpoch)
  assert.ok(ack.ownerEpoch > 0)
  session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('resized without requestId keeps the old wire shape', async () => {
  resetExclusiveOwnershipForTest()
  const { session, sent } = createSession()
  ;(session as any).refreshAttachedClient = async () => {}
  session.resize(100, 40)
  await new Promise((r) => setTimeout(r, RESIZE_ACK_OUTPUT_WAIT_MS + 80))
  const ack = sent.find((m) => m.type === 'resized')
  // undefined 字段被 JSON.stringify 丢弃：旧前端看不到多余字段
  assert.ok(!('requestId' in ack))
  assert.equal(ack.cols, 100)
  session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('superseded resize never acks the stale requestId', async () => {
  resetExclusiveOwnershipForTest()
  const { session, sent } = createSession()
  let resolveFirst: (() => void) | null = null
  let calls = 0
  ;(session as any).refreshAttachedClient = () =>
    new Promise<void>((resolve) => {
      if (calls++ === 0) resolveFirst = resolve
      else resolve()
    })
  session.resize(100, 40, 'first')
  session.resize(140, 44, 'second')
  resolveFirst!()
  await new Promise((r) => setTimeout(r, RESIZE_ACK_OUTPUT_WAIT_MS + 80))
  const acks = sent.filter((m) => m.type === 'resized')
  // 被覆盖的旧主张只留最后一次 ACK；requestId 让前端确认对应的是 second
  assert.equal(acks.length, 1)
  assert.equal(acks[0].requestId, 'second')
  assert.equal(acks[0].cols, 140)
  assert.equal(acks[0].windowVersion, 2)
  session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('ownerEpoch bumps on steal; revoked and window-size carry the new epoch', () => {
  resetExclusiveOwnershipForTest()
  const a = createSession(200, 50)
  const b = createSession(80, 24)
  a.session.attachedExclusive = true
  claimExclusiveOwnership(a.session)
  const epochA = a.session.ownerEpoch
  assert.ok(epochA > 0)

  b.session.attachedExclusive = true
  claimExclusiveOwnership(b.session)
  assert.ok(b.session.ownerEpoch > epochA)
  // 降级端收到的 exclusive-revoked 带新世代号；自身 ownerEpoch 已归零
  const revoked = a.sent.find((m) => m.type === 'exclusive-revoked')
  assert.equal(revoked.ownerEpoch, b.session.ownerEpoch)
  assert.equal(a.session.ownerEpoch, 0)

  // demote 摘掉独占 pty；补回 mock 后仲裁下发的 window-size 同样带当前 epoch
  a.session.ptyProcess = mockPty()
  a.session.applyWindowSize(80, 24)
  const pushed = a.sent.find((m) => m.type === 'window-size')
  assert.equal(pushed.ownerEpoch, b.session.ownerEpoch)
  assert.equal(pushed.windowVersion, 1)
  a.session.cleanup()
  b.session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('windowVersion increments across owner asserts and arbitrated applies', async () => {
  resetExclusiveOwnershipForTest()
  const owner = createSession(120, 36)
  const viewer = createSession(120, 36)
  owner.session.attachedExclusive = true
  claimExclusiveOwnership(owner.session)
  ;(owner.session as any).refreshAttachedClient = async () => {}
  owner.session.resize(100, 40, 'r1')
  viewer.session.applyWindowSize(100, 40)
  const pushed = viewer.sent.find((m) => m.type === 'window-size')
  // owner 主张 v1 后仲裁应用 v2：同 key 共享一条尺寸决策时间线
  assert.equal(pushed.windowVersion, 2)
  await new Promise((r) => setTimeout(r, RESIZE_ACK_OUTPUT_WAIT_MS + 80))
  const ack = owner.sent.find((m) => m.type === 'resized')
  // ACK 携带主张时快照 v1：前端看到 v2 的 window-size 后可丢弃此旧 ACK
  assert.equal(ack.windowVersion, 1)
  owner.session.cleanup()
  viewer.session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('owner self-echo apply bumps version without pushing window-size', () => {
  resetExclusiveOwnershipForTest()
  const { session, sent } = createSession(137, 23)
  session.attachedExclusive = true
  claimExclusiveOwnership(session)
  session.desiredCols = 137
  session.desiredRows = 23
  session.applyWindowSize(137, 23, true)
  // 自回声不下发事件（防前端误判降级），但尺寸决策仍计入版本序列
  assert.equal(
    sent.some((m) => m.type === 'window-size'),
    false,
  )
  session.attachedCols = 60
  session.attachedRows = 24
  session.applyWindowSize(137, 23, true)
  const pushed = sent.find((m) => m.type === 'window-size')
  assert.equal(pushed.windowVersion, 2)
  assert.equal(pushed.ownerEpoch, session.ownerEpoch)
  session.cleanup()
  resetExclusiveOwnershipForTest()
})
