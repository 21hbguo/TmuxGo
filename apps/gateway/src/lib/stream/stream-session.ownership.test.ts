/**
 * Scenario-model tests: multi-device / multi-tab exclusive ownership.

模型约定（与产品语义一致）：
- 同一 host+session 同时最多一个 exclusive owner（当前在用端）
- 新的 exclusive claim 会 steal 所有权；前任立刻降级 shared+passive
- 降级端：不写 input/scroll、不参与 window-size 主张
- owner 断开后，幸存端可重新 claim；尺寸可恢复
 */
import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimExclusiveOwnership,
  releaseExclusiveOwnership,
  resetExclusiveOwnershipForTest,
  schedulePeerWindowSync,
  setWindowSizeQueryForTest,
  StreamSession,
} from './stream-session.js'

function createPeer(cols = 120, rows = 36) {
  const sent: Array<{ type?: string; data?: string; sessionName?: string; hostId?: string }> = []
  const writes: string[] = []
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
    pid: 0,
    resize(c: number, r: number) {
      resized.push([c, r])
    },
    write(data: string) {
      writes.push(data)
    },
    kill() {},
    onData() {},
    onExit() {},
  } as any
  session.registerPeer()
  return { session, sent, writes, resized }
}

test('S1 desktop exclusive owner; phone exclusive steal demotes desk', () => {
  resetExclusiveOwnershipForTest()
  const desk = createPeer(200, 50)
  const phone = createPeer(80, 24)
  desk.session.attachedExclusive = true
  desk.session.desiredCols = 200
  desk.session.desiredRows = 50
  desk.session.assertSeq = 1
  claimExclusiveOwnership(desk.session)
  assert.equal(desk.session.isExclusiveOwner(), true)

  phone.session.attachedExclusive = true
  phone.session.desiredCols = 80
  phone.session.desiredRows = 24
  phone.session.assertSeq = 2
  claimExclusiveOwnership(phone.session)

  // 前任立刻失去独占与写权限，并收到 exclusive-revoked
  assert.equal(desk.session.isExclusiveOwner(), false)
  assert.equal(desk.session.attachedExclusive, false)
  assert.equal(desk.session.attachedPassive, true)
  assert.equal(desk.session.desiredCols, 0)
  assert.ok(desk.sent.some((m) => m.type === 'exclusive-revoked' && m.sessionName === 'dev'))
  assert.equal(phone.session.isExclusiveOwner(), true)

  // 降级端 input 必须被丢弃
  desk.session.input('rm -rf /')
  assert.equal(desk.writes.length, 0)
  phone.session.input('ls')
  assert.equal(phone.writes.length, 1)

  // 降级端 resize 不得再形成尺寸主张
  desk.session.resize(200, 50)
  assert.equal(desk.session.desiredCols, 0)
  assert.equal(desk.session.assertSeq, 0)

  desk.session.cleanup()
  phone.session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('S2 owner disconnects; survivor can re-claim exclusive (phone leave / desk resume)', async () => {
  resetExclusiveOwnershipForTest()
  let winSize: { cols: number; rows: number } | null = { cols: 80, rows: 24 }
  setWindowSizeQueryForTest(async () => winSize)
  try {
    const desk = createPeer(200, 50)
    const phone = createPeer(80, 24)
    const track = (peer: ReturnType<typeof createPeer>) => {
      const original = peer.session.ptyProcess!.resize.bind(peer.session.ptyProcess)
      peer.session.ptyProcess!.resize = ((c: number, r: number) => {
        winSize = { cols: c, rows: r }
        original(c, r)
      }) as any
    }
    track(desk)
    track(phone)

    desk.session.attachedExclusive = true
    claimExclusiveOwnership(desk.session)
    // 手机接力 steal
    phone.session.attachedExclusive = true
    phone.session.desiredCols = 80
    phone.session.desiredRows = 24
    phone.session.assertSeq = 2
    claimExclusiveOwnership(phone.session)
    assert.equal(desk.session.attachedPassive, true)
    // demote 会摘掉 exclusive pty；生产由前端以 shared 重附着，这里补回 mock 以便续用
    if (!desk.session.ptyProcess) {
      desk.session.ptyProcess = {
        pid: 1,
        resize: (c: number, r: number) => {
          winSize = { cols: c, rows: r }
          desk.resized.push([c, r])
        },
        write: (d: string) => desk.writes.push(d),
        kill: () => {},
        onData: () => {},
        onExit: () => {},
      } as any
    }

    // 手机断开（上厕所回来关掉/切走）
    phone.session.cleanup()
    await new Promise((r) => setTimeout(r, 20))

    // 电脑重新 claim（焦点回到电脑）
    desk.session.attachedPassive = false
    desk.session.attachedExclusive = true
    desk.session.desiredCols = 200
    desk.session.desiredRows = 50
    desk.session.assertSeq = 3
    claimExclusiveOwnership(desk.session)
    assert.equal(desk.session.isExclusiveOwner(), true)
    schedulePeerWindowSync('local', 'dev', 0)
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(winSize, { cols: 200, rows: 50 })
    desk.session.cleanup()
  } finally {
    setWindowSizeQueryForTest(null)
    resetExclusiveOwnershipForTest()
  }
})

test('S3 background tab cannot affect focused owner (passive + no scroll)', () => {
  resetExclusiveOwnershipForTest()
  const focused = createPeer(120, 36)
  const bg = createPeer(120, 36)
  focused.session.attachedExclusive = true
  claimExclusiveOwnership(focused.session)

  // 后台标签：失焦降级
  bg.session.attachedExclusive = false
  bg.session.attachedPassive = true
  bg.session.input('evil')
  bg.session.queueScroll('dev', 'local', 5)
  bg.session.cancelCopyMode('dev', 'local')
  assert.equal(bg.writes.length, 0)

  // 前台 owner 正常工作
  focused.session.input('ok')
  assert.equal(focused.writes.length, 1)
  focused.session.cleanup()
  bg.session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('S4 double-active multi-device: only one exclusive owner remains', () => {
  resetExclusiveOwnershipForTest()
  const a = createPeer(120, 36)
  const b = createPeer(100, 30)
  a.session.attachedExclusive = true
  claimExclusiveOwnership(a.session)
  b.session.attachedExclusive = true
  claimExclusiveOwnership(b.session)
  a.session.attachedExclusive = true
  claimExclusiveOwnership(a.session)
  // last claim wins; previous demoted
  assert.equal(a.session.isExclusiveOwner(), true)
  assert.equal(b.session.isExclusiveOwner(), false)
  assert.equal(b.session.attachedPassive, true)
  assert.ok(b.sent.some((m) => m.type === 'exclusive-revoked'))
  a.session.cleanup()
  b.session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('S5 release on cleanup frees ownership for next client', () => {
  resetExclusiveOwnershipForTest()
  const first = createPeer()
  first.session.attachedExclusive = true
  claimExclusiveOwnership(first.session)
  first.session.cleanup()
  assert.equal(first.session.isExclusiveOwner(), false)
  const second = createPeer()
  second.session.attachedExclusive = true
  claimExclusiveOwnership(second.session)
  assert.equal(second.session.isExclusiveOwner(), true)
  second.session.cleanup()
  resetExclusiveOwnershipForTest()
})
