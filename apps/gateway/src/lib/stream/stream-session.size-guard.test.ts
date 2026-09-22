import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamSession, claimExclusiveOwnership, resetExclusiveOwnershipForTest } from './stream-session.js'

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
  session.registerPeer()
  return { session, sent, resized }
}

test('passive peer ignores remote resize (no pty steal)', () => {
  resetExclusiveOwnershipForTest()
  const { session, resized, sent } = createSession(120, 36)
  session.attachedPassive = true
  session.resize(80, 24)
  assert.equal(resized.length, 0)
  assert.ok(sent.some((m) => m.type === 'resized' && m.cols === 120))
  session.cleanup()
  resetExclusiveOwnershipForTest()
})

test('non-owner exclusive resize does not assert desired size', () => {
  resetExclusiveOwnershipForTest()
  const owner = createSession(80, 24)
  const loser = createSession(120, 36)
  loser.session.attachedExclusive = true
  claimExclusiveOwnership(loser.session)
  owner.session.attachedExclusive = true
  claimExclusiveOwnership(owner.session)
  // steal 后 loser 被降级
  assert.equal(loser.session.attachedPassive, true)
  assert.equal(owner.session.isExclusiveOwner(), true)
  // demote 会摘 pty；补回后模拟前端尚未跟着降级仍发 resize
  loser.session.ptyProcess = {
    pid: 2,
    resize: () => {},
    write: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  } as any
  loser.session.attachedPassive = false
  loser.session.attachedExclusive = true
  loser.session.resize(120, 36)
  assert.equal(loser.session.desiredCols, 0)
  assert.equal(loser.session.isExclusiveOwner(), false)
  owner.session.cleanup()
  loser.session.cleanup()
  resetExclusiveOwnershipForTest()
})
