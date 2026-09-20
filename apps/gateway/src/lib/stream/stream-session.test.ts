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
