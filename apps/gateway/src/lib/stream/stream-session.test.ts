import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamSession } from './stream-session.js'

const FRAME_BEGIN = '\u001b[?25l'
const FRAME_END = '\u001b[?25h'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  return { session, sent }
}

test('flushOutput holds a wholly incomplete frame until its tail arrives', async () => {
  const { session, sent } = createSession()
  // 帧头先到、帧尾未回：不得把半个重绘帧发给客户端
  session.outputBuffer = `${FRAME_BEGIN}\u001b[2J\u001b[Hpartial`
  session.flushOutput()
  assert.equal(sent.length, 0)
  assert.ok(session.outputBuffer.endsWith('partial'))
  assert.ok(session.frameTailDeferred)
  // 帧尾到齐后下一拍整帧发出
  session.outputBuffer += `rest${FRAME_END}`
  await sleep(60)
  const output = sent.find((m) => m.type === 'output')
  assert.ok(output?.data)
  assert.ok(output.data.startsWith(FRAME_BEGIN))
  assert.ok(output.data.endsWith(FRAME_END))
  assert.equal(session.outputBuffer, '')
  session.cleanup()
})

test('flushOutput sends the complete frame prefix and keeps the partial tail', async () => {
  const { session, sent } = createSession()
  const frameA = `${FRAME_BEGIN}frame-A${FRAME_END}`
  session.outputBuffer = frameA + `${FRAME_BEGIN}tail-not-yet`
  session.flushOutput()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data, frameA)
  assert.equal(session.outputBuffer, `${FRAME_BEGIN}tail-not-yet`)
  session.cleanup()
})

test('flushOutput sends a still-incomplete frame after one bounded defer', async () => {
  const { session, sent } = createSession()
  session.outputBuffer = `${FRAME_BEGIN}never-closes`
  session.flushOutput()
  assert.equal(sent.length, 0)
  // 帧尾始终不来：defer 一次后仍按原样发，不能无限挂起
  await sleep(60)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data, `${FRAME_BEGIN}never-closes`)
  session.cleanup()
})

test('flushOutput sends complete frames without deferring', () => {
  const { session, sent } = createSession()
  session.outputBuffer = `${FRAME_BEGIN}ok${FRAME_END}`
  session.flushOutput()
  assert.equal(sent.length, 1)
  assert.equal(session.frameTailDeferred, false)
  session.cleanup()
})
