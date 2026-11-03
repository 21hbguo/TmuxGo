import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionChangeFeed, sessionChangeSignature, type SessionChangeSnapshot } from './session-change-feed.js'
import type { SessionChangeFeedOptions } from './session-change-feed.js'

const HOST = 'local'

function snapshot(name: string, extra: Partial<SessionChangeSnapshot> = {}): SessionChangeSnapshot {
  return { name, windowCount: 1, attached: false, ...extra }
}

function feedWith(overrides: SessionChangeFeedOptions = {}) {
  return new SessionChangeFeed({ intervalMs: 20, maxIntervalMs: 40, watchGraceMs: 20, ...overrides })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('signature ignores tmux output order but tracks structural fields', () => {
  const left = sessionChangeSignature([snapshot('b'), snapshot('a', { windowCount: 3 })])
  const right = sessionChangeSignature([snapshot('a', { windowCount: 3 }), snapshot('b')])
  assert.equal(left, right)
  assert.notEqual(left, sessionChangeSignature([snapshot('a', { windowCount: 4 }), snapshot('b')]))
  assert.notEqual(left, sessionChangeSignature([snapshot('a', { windowCount: 3, attached: true }), snapshot('b')]))
  assert.notEqual(left, sessionChangeSignature([snapshot('a', { windowCount: 3 })]))
})

test('the first snapshot only sets the baseline, later differences bump once', () => {
  const feed = feedWith()
  try {
    assert.equal(feed.getRevision(HOST), 0)
    assert.equal(feed.noteSessions(HOST, [snapshot('a')]), false)
    assert.equal(feed.getRevision(HOST), 0)
    // 同一份列表（顺序不同）不算变化：探针每 2s 跑一次，不能每次都 invalidate
    assert.equal(feed.noteSessions(HOST, [snapshot('a')]), false)
    assert.equal(feed.getRevision(HOST), 0)
    assert.equal(feed.noteSessions(HOST, [snapshot('a'), snapshot('b')]), true)
    assert.equal(feed.getRevision(HOST), 1)
  } finally {
    feed.dispose()
  }
})

test('markChanged bumps without a probe (gateway-side create/rename/delete)', () => {
  const feed = feedWith()
  try {
    assert.equal(feed.markChanged(HOST), 1)
    assert.equal(feed.markChanged(HOST), 2)
    assert.equal(feed.getRevision(HOST), 2)
  } finally {
    feed.dispose()
  }
})

test('waitForChange resolves immediately when the revision already moved', async () => {
  const feed = feedWith()
  try {
    feed.markChanged(HOST)
    const result = await feed.waitForChange(HOST, 0, 5000)
    assert.deepEqual(result, { revision: 1, changed: true })
    assert.equal(feed.waiterCount, 0)
  } finally {
    feed.dispose()
  }
})

test('waitForChange wakes on a probe-detected change', async () => {
  const feed = feedWith()
  try {
    feed.noteSessions(HOST, [snapshot('a')])
    const pending = feed.waitForChange(HOST, feed.getRevision(HOST), 1000)
    assert.equal(feed.waiterCount, 1)
    feed.noteSessions(HOST, [snapshot('a'), snapshot('b')])
    assert.deepEqual(await pending, { revision: 1, changed: true })
    assert.equal(feed.waiterCount, 0)
  } finally {
    feed.dispose()
  }
})

test('waitForChange returns changed=false on timeout and keeps the revision', async () => {
  const feed = feedWith()
  try {
    feed.noteSessions(HOST, [snapshot('a')])
    assert.deepEqual(await feed.waitForChange(HOST, 0, 30), { revision: 0, changed: false })
  } finally {
    feed.dispose()
  }
})

test('an aborted request settles the waiter instead of holding the slot', async () => {
  const feed = feedWith()
  try {
    const controller = new AbortController()
    const pending = feed.waitForChange(HOST, 0, 5000, controller.signal)
    assert.equal(feed.waiterCount, 1)
    controller.abort()
    assert.deepEqual(await pending, { revision: 0, changed: false })
    assert.equal(feed.waiterCount, 0)
  } finally {
    feed.dispose()
  }
})

test('the probe only runs while somebody waits', async () => {
  let calls = 0
  const feed = feedWith({
    listSessions: async () => {
      calls += 1
      return [snapshot('a')]
    },
  })
  try {
    assert.equal(feed.watchedHostIds.length, 0)
    // wait=50ms：期间探针按 20ms 节拍跑，不应等到过期才动
    await feed.waitForChange(HOST, 0, 50)
    assert.ok(calls >= 1, `probe calls=${calls}`)
    // 最后一个等待者离开后，宽限期（20ms）结束就该停表：再等一段时间不再加数
    await sleep(60)
    assert.equal(feed.watchedHostIds.length, 0)
    const after = calls
    await sleep(60)
    assert.equal(calls, after, `probe kept running after grace: ${calls} -> ${after}`)
  } finally {
    feed.dispose()
  }
})

test('probe failures back off and never bump the revision', async () => {
  let calls = 0
  const feed = feedWith({
    intervalMs: 10,
    maxIntervalMs: 40,
    listSessions: async () => {
      calls += 1
      throw new Error('ssh: connect to host failed')
    },
  })
  try {
    const result = await feed.waitForChange(HOST, 0, 120)
    assert.deepEqual(result, { revision: 0, changed: false })
    // 10ms 起、10/20/40/40… 退避：120ms 内的失败次数应远小于「每 10ms 一次」的 12 次
    assert.ok(calls >= 1 && calls <= 8, `probe calls=${calls}`)
  } finally {
    feed.dispose()
  }
})

test('a session list that shrinks to empty still counts as a change', () => {
  const feed = feedWith()
  try {
    feed.noteSessions(HOST, [snapshot('a')])
    const revision = feed.getRevision(HOST)
    assert.equal(feed.noteSessions(HOST, []), true)
    assert.equal(feed.getRevision(HOST), revision + 1)
  } finally {
    feed.dispose()
  }
})

test('drain releases pending long polls so shutdown does not wait for the whole window', async () => {
  const feed = feedWith()
  try {
    const pending = feed.waitForChange(HOST, 0, 10000)
    assert.equal(feed.waiterCount, 1)
    feed.drain()
    assert.deepEqual(await pending, { revision: 0, changed: false })
    assert.equal(feed.waiterCount, 0)
    // drain 不封锁实例：同进程重建 app 还要继续用
    const after = feed.waitForChange(HOST, 0, 20)
    feed.markChanged(HOST)
    assert.equal((await after).changed, true)
  } finally {
    feed.dispose()
  }
})
