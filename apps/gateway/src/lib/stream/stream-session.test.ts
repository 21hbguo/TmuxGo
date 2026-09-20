import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamSession } from './stream-session.js'

const FRAME_BEGIN = '\u001b[?25l'

function createSession() {
  const sent: Array<{ type?: string; data?: string }> = []
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
  session.attachedCols = 80
  session.attachedRows = 24
  session.ptyProcess = { pid: 0, resize() {}, write() {}, kill() {}, onData() {}, onExit() {} } as any
  return { session, sent }
}

test('completeResizeAck sends buffered output before the resized ack', () => {
  const { session, sent } = createSession()
  // ACK 不得越过既有字节：前端时间点屏障按"已收到输出"计账，
  // resized 抢先在 output 前到达会让屏障看到空队列而误判放行
  session.outputBuffer = `${FRAME_BEGIN}\u001b[2J\u001b[Hresize-output`
  session.pendingResizeAck = {
    sessionName: 'dev',
    hostId: 'local',
    cols: 80,
    rows: 24,
    seq: session.attachSeq,
    refreshComplete: true,
    outputObserved: true,
    startedAt: Date.now(),
  }
  session.completeResizeAck()
  assert.deepEqual(
    sent.map((m) => m.type),
    ['output', 'resized'],
  )
  assert.equal(session.outputBuffer, '')
  session.cleanup()
})

test('flushOutput sends an unclosed cursor-hide sequence immediately (no frame-tail wait)', () => {
  const { session, sent } = createSession()
  // ?25l/?25h 不是可靠帧协议：只开不收的 chunk 也得原样立发，不能等帧尾
  session.outputBuffer = `${FRAME_BEGIN}never-closes`
  session.flushOutput()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'output')
  assert.equal(sent[0].data, `${FRAME_BEGIN}never-closes`)
  assert.equal(session.outputBuffer, '')
  session.cleanup()
})

test('flushOutput sends buffered bytes in order regardless of content shape', () => {
  const { session, sent } = createSession()
  session.outputBuffer = `plain-a${FRAME_BEGIN}mixed-b`
  session.flushOutput()
  session.outputBuffer = 'next-c'
  session.flushOutput()
  assert.equal(sent.length, 2)
  assert.equal(sent[0].data, `plain-a${FRAME_BEGIN}mixed-b`)
  assert.equal(sent[1].data, 'next-c')
  session.cleanup()
})

test('flushOutputResync sends only the reset boundary, never a fabricated pane snapshot', async () => {
  const { session, sent } = createSession()
  ;(session as any).redrawAttachedClient = async () => {}
  session.outputResyncPending = true
  await session.flushOutputResync()
  // resync 负载必须是 DECSTR+ED+CUP 边界序列；真正的整屏内容由随后的
  // tmux 真实重绘（普通 output）恢复，不得夹带手拼 pane 定位块
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'output_resync')
  assert.equal(sent[0].data, '\u001b[!p\u001b[2J\u001b[H')
  assert.ok(!sent[0].data.includes('\u001b[0m'))
  assert.equal(session.outputResyncPending, false)
  session.cleanup()
})

test('flushOutputResync re-arms pending when the tmux redraw fails', async () => {
  const { session, sent } = createSession()
  // 受控失败：refresh 拒绝后 resync 必须保持 pending 走整轮重试，
  // 而不是把清屏后的残局交给普通输出
  ;(session as any).redrawAttachedClient = async () => {
    throw new Error('refresh-client failure')
  }
  session.outputResyncPending = true
  await session.flushOutputResync()
  assert.equal(sent[0]?.type, 'output_resync')
  assert.equal(session.outputResyncPending, true)
  session.cleanup()
})

test('a stale resync failure must not touch the new attach epoch', async () => {
  const { session } = createSession()
  let reject: (e: Error) => void = () => {}
  ;(session as any).redrawAttachedClient = () => new Promise((_, r) => (reject = r))
  session.outputResyncPending = true
  const work = session.flushOutputResync()
  // 模拟 cleanup + 新 attach：新一轮 resync 已在自己的 epoch 里运行
  session.cleanup()
  session.ptyProcess = { pid: 2, resize() {}, write() {}, kill() {}, onData() {}, onExit() {} } as any
  session.attachedSessionName = 'new'
  session.outputResyncPending = false
  session.outputResyncRunning = true
  reject(new Error('old redraw failed'))
  await work
  assert.equal(session.attachedSessionName, 'new')
  assert.equal(session.outputResyncPending, false)
  assert.equal(session.outputResyncRunning, true)
  assert.equal(session.deferredFlushTimer, null)
  session.cleanup()
})

test('a stale resync success must not touch the new attach epoch either', async () => {
  const { session } = createSession()
  let resolve: () => void = () => {}
  ;(session as any).redrawAttachedClient = () => new Promise<void>((r) => (resolve = r))
  session.outputResyncPending = true
  const work = session.flushOutputResync()
  session.cleanup()
  session.ptyProcess = { pid: 2, resize() {}, write() {}, kill() {}, onData() {}, onExit() {} } as any
  session.attachedSessionName = 'new'
  session.outputResyncPending = false
  session.outputResyncRunning = true
  resolve()
  await work
  assert.equal(session.outputResyncPending, false)
  assert.equal(session.outputResyncRunning, true)
  assert.equal(session.deferredFlushTimer, null)
  session.cleanup()
})
