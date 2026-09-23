import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IPty } from 'node-pty'
import { setPtySpawnForTest } from '../terminal-attachment.js'
import { setPrepareSessionAttachForTest } from '../tmux-policy.js'
import { setRefreshExecForTest } from './stream-tmux.js'
import {
  claimExclusiveOwnership,
  resetExclusiveOwnershipForTest,
  setWindowSizeQueryForTest,
  StreamSession,
} from './stream-session.js'
import { resetSharedTerminalsForTest, countSharedTerminals } from './shared-terminal.js'
import { streamPerfMetrics } from '../perf-metrics.js'
import { STREAM_FANOUT_ENABLED, RESYNC_RESET_SEQ } from './stream-config.js'

type FakePty = IPty & {
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
  killed: boolean
  resizes: Array<[number, number]>
  writes: string[]
}

function fakePty(pid: number): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  const resizes: Array<[number, number]> = []
  const writes: string[] = []
  let killed = false
  return {
    pid,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    write: (data: string) => {
      writes.push(data)
    },
    resize: (cols: number, rows: number) => {
      resizes.push([cols, rows])
    },
    kill: () => {
      killed = true
    },
    clear: () => {},
    pause: () => {},
    resume: () => {},
    onData: (listener: (data: string) => void) => {
      dataListeners.push(listener)
      return { dispose: () => {} }
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener)
      return { dispose: () => {} }
    },
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data)
    },
    emitExit: (exitCode: number) => {
      for (const listener of exitListeners) listener({ exitCode })
    },
    get killed() {
      return killed
    },
    get resizes() {
      return resizes
    },
    get writes() {
      return writes
    },
  } as unknown as FakePty
}

function createSocket() {
  const sent: any[] = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer) {
      const raw = String(data)
      if (raw.startsWith('{')) sent.push(JSON.parse(raw))
      else sent.push({ __binary: true, buf: data as Buffer })
    },
    close() {},
  }
  return { socket, sent }
}

function setupPtySpawn() {
  const spawns: FakePty[] = []
  setPtySpawnForTest((_file, _args, options) => {
    const pty = fakePty(1000 + spawns.length)
    if (typeof options.cols === 'number') (pty as { cols: number }).cols = options.cols
    if (typeof options.rows === 'number') (pty as { rows: number }).rows = options.rows
    spawns.push(pty)
    return pty
  })
  return spawns
}

function setupEnv() {
  setPrepareSessionAttachForTest(async () => {})
  setWindowSizeQueryForTest(async () => ({ cols: 80, rows: 24 }))
  setRefreshExecForTest(async () => ({ stdout: '1|/dev/pts/mock\n', stderr: '', host: null }) as any)
}

function teardownEnv() {
  setPtySpawnForTest((() => {
    throw new Error('pty spawn not mocked')
  }) as any)
  setPrepareSessionAttachForTest(null)
  setWindowSizeQueryForTest(null)
  setRefreshExecForTest(null)
  resetSharedTerminalsForTest()
  resetExclusiveOwnershipForTest()
}

test('fanout flag defaults on', () => {
  assert.equal(STREAM_FANOUT_ENABLED, true)
})

test('two attaches on same host+session share one PTY and both receive output', async () => {
  assert.ok(STREAM_FANOUT_ENABLED, 'fanout must be enabled for this suite')
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    assert.equal(spawns.length, 1, 'PTY must be created only once')
    assert.equal(countSharedTerminals(), 1)
    assert.equal(sa.sharedHub, sb.sharedHub)
    assert.ok(a.sent.some((m) => m.type === 'attached'))
    assert.ok(b.sent.some((m) => m.type === 'attached'))

    a.sent.length = 0
    b.sent.length = 0
    // hub sanitize 一次后扇出：两端各自组帧发送
    spawns[0].emitData('hello-fanout')
    await sa.flushOutput()
    await sb.flushOutput()
    assert.ok(
      a.sent.some((m) => m.type === 'output' && m.data.includes('hello-fanout')),
      'client A should receive output',
    )
    assert.ok(
      b.sent.some((m) => m.type === 'output' && m.data.includes('hello-fanout')),
      'client B should receive output',
    )
    // sanitize 只做一次（hub 级），不是每订阅者一次
    // emit 前后差值应为 1
    // (streamPerfMetrics.sanitizeCalls 已累计，捕获增量)
    sa.cleanup()
    sb.cleanup()
    assert.equal(countSharedTerminals(), 0)
    assert.ok(spawns[0].killed, 'PTY killed after last subscriber leaves')
  } finally {
    teardownEnv()
  }
})

test('one detach keeps PTY alive for the remaining subscriber; last detach kills it', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    assert.equal(spawns.length, 1)

    a.sent.length = 0
    b.sent.length = 0
    sa.cleanup()
    assert.equal(spawns[0].killed, false, 'PTY must survive while B remains')
    assert.equal(countSharedTerminals(), 1)

    spawns[0].emitData('still-alive')
    await sb.flushOutput()
    assert.ok(b.sent.some((m) => m.type === 'output' && m.data.includes('still-alive')))

    sb.cleanup()
    assert.equal(spawns[0].killed, true, 'PTY killed after last subscriber leaves')
    assert.equal(countSharedTerminals(), 0)
  } finally {
    teardownEnv()
  }
})

test('exclusive claim demotes previous; passive stays write-blocked; resync only clears requesting subscriber buffer', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: true, cols: 120, rows: 40 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: true, cols: 80, rows: 24 })
    // 后到 exclusive 踢掉前任
    assert.equal(sa.isExclusiveOwner(), false)
    assert.equal(sb.isExclusiveOwner(), true)
    assert.equal(sa.attachedPassive, true)
    assert.ok(a.sent.some((m) => m.type === 'exclusive-revoked'))
    // 共享 PTY 不因降级被杀
    assert.equal(spawns[0].killed, false)
    assert.equal(spawns.length, 1)

    // passive 禁写
    sa.input('evil')
    assert.equal(spawns[0].writes.length, 0)
    sb.input('ok')
    assert.equal(spawns[0].writes.length, 1)

    // resync 只清请求端缓冲；共享 hub 的 refresh 重绘会扇出全部订阅者——
    // 其它端在重绘前收 output_resync 边界做原子替换，积压先 flush 不丢
    sa.outputBuffer = 'stale-a'
    sb.outputBuffer = 'stale-b'
    ;(sa as any).redrawAttachedClient = async () => {}
    sa.requestLatestFrameResync()
    assert.equal(sa.outputResyncPending, true)
    assert.equal(sa.outputBuffer, '')
    assert.equal(sb.outputResyncPending, false)
    assert.equal(sb.outputBuffer, 'stale-b')
    await sa.flushOutputResync()
    assert.ok(a.sent.some((m) => m.type === 'output_resync' && m.data === RESYNC_RESET_SEQ))
    const bOutIdx = b.sent.findIndex((m) => m.type === 'output' && m.data === 'stale-b')
    const bResyncIdx = b.sent.findIndex((m) => m.type === 'output_resync')
    assert.ok(bOutIdx >= 0 && bResyncIdx > bOutIdx, 'B 的帧序：stale 输出 → reset 边界')
    assert.equal(b.sent.filter((m) => m.type === 'output_resync').length, 1)

    sa.cleanup()
    sb.cleanup()
  } finally {
    teardownEnv()
  }
})

test('subscribers with different caps get their own encodings from shared output', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    assert.equal(spawns.length, 1)

    // A: binary+gzip；B: 纯 JSON 明文
    sa.applyCaps({ binaryOutput: true, compressOutput: 'gzip' })
    sb.applyCaps({ binaryOutput: false })
    assert.equal(sa.compressOutputEnabled, true)
    assert.equal(sb.compressOutputEnabled, false)

    a.sent.length = 0
    b.sent.length = 0
    const payload = 'X'.repeat(2000)
    spawns[0].emitData(payload)
    await sa.flushOutput()
    await sb.flushOutput()

    const aBinary = a.sent.find((m) => m.__binary)
    const bJson = b.sent.find((m) => m.type === 'output')
    assert.ok(aBinary, 'gzip client should receive a binary frame')
    assert.ok(bJson, 'plain client should receive JSON output')
    assert.equal(typeof bJson.data, 'string')
    // A 的二进制帧应与明文 JSON 不同编码路径（type 3/4 = gzip）
    const frame = aBinary.buf as Buffer
    assert.equal(frame[0], 0x54) // 'T'
    assert.equal(frame[1], 0x47) // 'G'
    assert.ok([3, 4].includes(frame[3]), `expected compressed output type, got ${frame[3]}`)

    sa.cleanup()
    sb.cleanup()
    assert.equal(spawns[0].killed, true)
  } finally {
    teardownEnv()
  }
})

test('sanitize runs once per hub chunk (sharedPtyReuses + sharedTerminals metrics)', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const beforeSanitize = streamPerfMetrics.sanitizeCalls
    const beforeReuse = streamPerfMetrics.sharedPtyReuses
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    assert.equal(streamPerfMetrics.sharedPtyReuses, beforeReuse + 1)
    assert.equal(streamPerfMetrics.sharedTerminals, 1)

    spawns[0].emitData('once')
    assert.equal(streamPerfMetrics.sanitizeCalls, beforeSanitize + 1, 'one sanitize per chunk, not per subscriber')

    sa.cleanup()
    sb.cleanup()
    assert.equal(streamPerfMetrics.sharedTerminals, 0)
  } finally {
    teardownEnv()
  }
})

test('PTY exit notifies all subscribers and clears the hub', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    spawns[0].emitExit(0)
    assert.ok(a.sent.some((m) => m.type === 'session-exit'))
    assert.ok(b.sent.some((m) => m.type === 'session-exit'))
    assert.equal(sa.ptyProcess, null)
    assert.equal(sb.ptyProcess, null)
    assert.equal(countSharedTerminals(), 0)
    sa.cleanup()
    sb.cleanup()
  } finally {
    teardownEnv()
  }
})

test('non-owner shared resize does not drive the shared PTY', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    // A exclusive owner, B shared viewer
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: true, cols: 120, rows: 40 })
    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    assert.equal(spawns.length, 1)
    const resizesBefore = spawns[0].resizes.length

    b.sent.length = 0
    sb.resize(100, 30)
    // B 非 owner：不 resize 共享 PTY，只回当前尺寸
    assert.equal(spawns[0].resizes.length, resizesBefore)
    assert.ok(b.sent.some((m) => m.type === 'resized' && m.cols === sb.attachedCols))

    a.sent.length = 0
    sa.resize(140, 44)
    assert.ok(spawns[0].resizes.some(([c, r]) => c === 140 && r === 44))
    assert.equal(sa.isExclusiveOwner(), true)

    sa.cleanup()
    sb.cleanup()
    assert.equal(spawns[0].killed, true)
  } finally {
    teardownEnv()
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// attach 重绘合并去重（RB）：list-clients 回包 pid 必须命中 hub pty
// （首个 spawn pid=1000）refresh-client 才有目标；计数只算 refresh-client
function setupRefreshExec(fail = false) {
  const calls: string[][] = []
  setRefreshExecForTest(async (_host: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'refresh-client') {
      if (fail) throw new Error('refresh-client failure')
      return { stdout: '', stderr: '', host: null } as any
    }
    return { stdout: '1000|/dev/pts/mock\n', stderr: '', host: null } as any
  })
  return () => calls.filter((args) => args[0] === 'refresh-client').length
}

test('attach refresh dedup: visible output before the first slot cancels every refresh', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  const refreshCount = setupRefreshExec()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    // attach 返回后同步到达的首个有效输出：0/48/120 槽位全部应取消
    spawns[0].emitData('seed-output')
    await sleep(200)
    assert.equal(refreshCount(), 0)
    sa.cleanup()
  } finally {
    teardownEnv()
  }
})

test('attach refresh dedup: quiet pane fires once per merged slot (0/48/120 = 3, was 4)', async () => {
  setupEnv()
  setupPtySpawn()
  const refreshCount = setupRefreshExec()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    // 无输出：两路兜底原会在 48ms 撞车双发（0+48+48+120=4）；合并后每槽一次
    await sleep(200)
    assert.equal(refreshCount(), 3)
    sa.cleanup()
  } finally {
    teardownEnv()
  }
})

test('attach refresh dedup: failing refresh keeps exactly one bounded retry', async () => {
  setupEnv()
  setupPtySpawn()
  const refreshCount = setupRefreshExec(true)
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    // t=0 失败 → t=48 重试失败 → done：t=120 不再发，总数 2 而非 3
    await sleep(200)
    assert.equal(refreshCount(), 2)
    sa.cleanup()
  } finally {
    teardownEnv()
  }
})

test('attach refresh dedup: output mid-window cancels the remaining slots', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  const refreshCount = setupRefreshExec()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sleep(60) // 0/48 槽位已各发一次
    spawns[0].emitData('late-output')
    await sleep(200) // 120 槽位看到有效输出 → done
    assert.equal(refreshCount(), 2)
    sa.cleanup()
  } finally {
    teardownEnv()
  }
})

test('fanout redraw broadcast: B attach redraws once and peers get the reset boundary first', async () => {
  setupEnv()
  const spawns = setupPtySpawn()
  const refreshCount = setupRefreshExec()
  resetExclusiveOwnershipForTest()
  resetSharedTerminalsForTest()
  try {
    const a = createSocket()
    const b = createSocket()
    const sa = new StreamSession(a.socket as any, null)
    const sb = new StreamSession(b.socket as any, null)
    await sa.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    spawns[0].emitData('seed-a') // A 首轮有效输出 → A 的兜底计划直接 done
    await sleep(10)
    a.sent.length = 0

    await sb.attach({ hostId: 'local', sessionName: 'test', exclusive: false, cols: 80, rows: 24 })
    await sleep(10) // B 的 t=0 槽位：先广播 output_resync 边界，再 refresh
    spawns[0].emitData('REDRAW-MARKER') // 共享重绘字节经 hub 扇出两端
    await sleep(200)

    assert.equal(refreshCount(), 1, 'B attach 合并后只发一次 refresh-client')
    const aResyncs = a.sent.filter((m) => m.type === 'output_resync')
    assert.equal(aResyncs.length, 1, 'A 只收一次 reset 边界')
    assert.equal(aResyncs[0].data, RESYNC_RESET_SEQ)
    const aRedraws = a.sent.filter(
      (m) => m.type === 'output' && typeof m.data === 'string' && m.data.includes('REDRAW-MARKER'),
    )
    assert.equal(aRedraws.length, 1, 'A 收到的整屏重绘只一次')
    const resyncIdx = a.sent.findIndex((m) => m.type === 'output_resync')
    const redrawIdx = a.sent.findIndex(
      (m) => m.type === 'output' && typeof m.data === 'string' && m.data.includes('REDRAW-MARKER'),
    )
    assert.ok(resyncIdx >= 0 && redrawIdx > resyncIdx, '帧序必须是 边界 → 重绘，才能原子替换')
    // 新订者同样收到一份边界（恢复语义按端下发，重绘字节只能广播）
    assert.equal(b.sent.filter((m) => m.type === 'output_resync').length, 1)
    sa.cleanup()
    sb.cleanup()
  } finally {
    teardownEnv()
  }
})

test('claimExclusiveOwnership still demotes without hub (legacy path)', () => {
  resetExclusiveOwnershipForTest()
  const mk = () => {
    const { socket } = createSocket()
    const s = new StreamSession(socket as any, null)
    s.attachedSessionName = 'dev'
    s.attachedHostId = 'local'
    s.attachedExclusive = true
    s.ptyProcess = { pid: 1, resize() {}, write() {}, kill() {}, onData() {}, onExit() {} } as any
    return s
  }
  const first = mk()
  const second = mk()
  claimExclusiveOwnership(first)
  claimExclusiveOwnership(second)
  assert.equal(first.isExclusiveOwner(), false)
  assert.equal(first.attachedPassive, true)
  // legacy demote kills own pty
  assert.equal(first.ptyProcess, null)
  first.cleanup()
  second.cleanup()
  resetExclusiveOwnershipForTest()
})
