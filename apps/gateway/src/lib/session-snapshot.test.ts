import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readdir } from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  SESSION_SNAPSHOT_KIND,
  SNAPSHOT_MAX_COUNT,
  SNAPSHOT_TAIL_BYTES,
  SNAPSHOT_TAIL_LINES,
  captureSessionSnapshot,
  describeShutdownSnapshots,
  getSnapshotDir,
  readSnapshots,
  restoreSnapshot,
  snapshotSessionsOnShutdown,
  summarizeSkipReasons,
} from './session-snapshot.js'
import type { TmuxExec } from './session-layout-apply.js'

// 假 tmux：按命令首词 + 关键参数返回固定输出，记录调用序列用于断言恢复重放内容
function createFakeTmux(options: { sessions?: string[]; tail?: string; failCapture?: boolean } = {}) {
  const calls: string[][] = []
  const exec = (async (_hostId: string, args: string[]) => {
    calls.push(args)
    const [cmd] = args
    if (cmd === 'list-sessions') return { stdout: (options.sessions || ['work']).join('\n') + '\n', stderr: '' }
    if (cmd === 'list-windows') {
      // 只要索引的查询（无 '|'）返回裸索引，带 window_name 的返回 '索引|名字'
      const format = args[args.indexOf('-F') + 1] || ''
      if (!format.includes('|')) return { stdout: '0\n1\n', stderr: '' }
      return { stdout: '0|editor\n1|logs\n', stderr: '' }
    }
    if (cmd === 'list-panes') {
      const paneFormat = args[args.indexOf('-F') + 1] || ''
      if (!paneFormat.includes('|')) return { stdout: '0\n', stderr: '' }
      return {
        stdout: [
          '0|0|%0|nvim|/repo/app|nvim|0|80|24|0|0',
          '0|1|%1|shell|/repo/app|zsh|1|80|24|80|0',
          '1|0|%2|logs|/var/log|tail|0|160|12|0|0',
        ].join('\n'),
        stderr: '',
      }
    }
    if (cmd === 'capture-pane') {
      if (options.failCapture) throw new Error('capture failed')
      return { stdout: options.tail ?? 'line1\nline2\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }) as unknown as TmuxExec
  return { exec, calls }
}

async function withConfigDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-snapshot-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  try {
    await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('captures an L1 snapshot: layout + per pane cwd/command + tail', async () => {
  await withConfigDir(async () => {
    const { exec, calls } = createFakeTmux({ tail: 'last-a\nlast-b\n' })
    const snapshot = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec,
    })
    assert.equal(snapshot.kind, SESSION_SNAPSHOT_KIND)
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.sessionName, 'work')
    // TTL 7 天（±1 分钟容差，避免踩时钟抖动）
    const ttlDays = (Date.parse(snapshot.expiresAt) - Date.parse(snapshot.createdAt)) / 86400000
    assert.equal(Math.round(ttlDays), 7)
    assert.equal(snapshot.stats.paneCount, 3)
    assert.equal(snapshot.stats.tailLines, SNAPSHOT_TAIL_LINES)
    assert.deepEqual(
      snapshot.panes.map((pane) => [pane.tmuxPaneId, pane.cwd, pane.command, pane.inMode]),
      [
        ['%0', '/repo/app', 'nvim', false],
        ['%1', '/repo/app', 'zsh', true],
        ['%2', '/var/log', 'tail', false],
      ],
    )
    assert.equal(snapshot.panes[0]!.scrollbackTail, 'last-a\nlast-b\n')
    // layout 内嵌 session-layout v1，结构与 cwd 都在里面
    assert.equal(snapshot.layout.kind, 'tmuxgo.session-layout')
    assert.deepEqual(snapshot.layout.windows[0]!.panes, [{ command: 'nvim', cwd: '/repo/app' }, { cwd: '/repo/app' }])
    assert.equal(snapshot.layout.windows[1]!.name, 'logs')
    // capture-pane 取 200 行
    const captureCall = calls.find((args) => args[0] === 'capture-pane')
    assert.deepEqual(captureCall?.slice(-2), ['-S', '-200'])
  })
})

test('caps tail bytes and degrades when capture fails instead of throwing', async () => {
  await withConfigDir(async () => {
    const big = 'x'.repeat(SNAPSHOT_TAIL_BYTES + 100)
    const capped = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec: createFakeTmux({ tail: big }).exec,
    })
    assert.equal(Buffer.byteLength(capped.panes[0]!.scrollbackTail, 'utf8'), SNAPSHOT_TAIL_BYTES)

    const failed = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec: createFakeTmux({ failCapture: true }).exec,
    })
    assert.equal(failed.panes[0]!.scrollbackTail, '')
    assert.ok(failed.degraded.includes('scrollback'))
  })
})

test('withTail=false keeps structure only and marks the snapshot degraded', async () => {
  await withConfigDir(async () => {
    const { exec, calls } = createFakeTmux()
    const snapshot = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      withTail: false,
      exec,
    })
    assert.equal(
      snapshot.panes.every((pane) => pane.scrollbackTail === ''),
      true,
    )
    assert.deepEqual(snapshot.degraded, ['scrollback'])
    assert.equal(
      calls.some((args) => args[0] === 'capture-pane'),
      false,
    )
  })
})

test('prunes expired snapshots and keeps the newest ones within the count cap', async () => {
  await withConfigDir(async () => {
    const { exec } = createFakeTmux()
    const dir = getSnapshotDir('local')
    const first = await captureSessionSnapshot({ hostId: 'local', sessionId: 'session-local-work', exec })
    // 手工塞入过期文档与超量文档
    const { mkdir } = await import('fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'expired.json'),
      // 过期但时间戳最新：只有真的按 TTL 判过期才会清掉它（否则会被「保留最新 100 份」留下来）
      JSON.stringify({
        ...first,
        id: 'expired',
        createdAt: new Date(Date.now() + 3600000).toISOString(),
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    )
    await writeFile(path.join(dir, 'garbage.json'), '{not json')
    for (let i = 0; i < SNAPSHOT_MAX_COUNT + 5; i += 1) {
      await writeFile(
        path.join(dir, `bulk-${i}.json`),
        JSON.stringify({
          ...first,
          id: `bulk-${i}`,
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      )
    }
    const snapshots = await readSnapshots('local')
    assert.equal(snapshots.length, SNAPSHOT_MAX_COUNT)
    const names = await readdir(dir)
    assert.equal(
      names.some((name) => name === 'expired.json' || name === 'garbage.json'),
      false,
    )
    // 最新的 bulk-104 必须留下，最老的 bulk-0 被修剪
    assert.equal(names.includes('bulk-104.json'), true)
    assert.equal(names.includes('bulk-0.json'), false)
  })
})

test('restore replays layout + cwd + command but never writes the tail back into panes', async () => {
  await withConfigDir(async () => {
    const capture = createFakeTmux({ sessions: ['work'], tail: 'old output\n' })
    const snapshot = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec: capture.exec,
    })
    const restore = createFakeTmux({ sessions: [] })
    const result = await restoreSnapshot({
      hostId: 'local',
      snapshotId: snapshot.id,
      exec: restore.exec,
      prepareAttach: async () => {},
    })
    assert.equal(result.sessionName, 'work')
    assert.equal(result.paneCount, 3)
    // 预览里带着尾部内容，恢复动作本身不回填
    assert.equal(result.panes[0]!.scrollbackTail, 'old output\n')
    const cmds = restore.calls.map((args) => args[0])
    assert.deepEqual(
      cmds.filter((cmd) => cmd !== 'send-keys'),
      [
        'list-sessions',
        'new-session',
        // window 0：改现有 window 名 → split 出第二个 pane → 应用版式
        'list-windows',
        'list-windows',
        'rename-window',
        'list-panes',
        'split-window',
        'select-layout',
        // window 1：新建 window → 应用版式 → 回到首个 window
        'new-window',
        'list-panes',
        'select-layout',
        'select-window',
      ],
    )
    // 只有非 shell 命令会被重跑（nvim / tail），zsh 这种 shell 不重放
    const typed = restore.calls.filter((args) => args[0] === 'send-keys' && args.includes('-l')).map((args) => args[4])
    // 每个 pane 至少回 cd（zsh 这种 shell 不重放命令，只回目录），非 shell 命令跟在 cd 后面
    assert.deepEqual(typed, ["cd -- '/repo/app'; nvim", "cd -- '/repo/app'", "cd -- '/var/log'; tail"])
    // 尾部内容没有作为 send-keys 文本出现
    assert.equal(
      restore.calls.some((args) => args.some((arg) => arg.includes('old output'))),
      false,
    )
  })
})

test('restore refuses to clobber an existing session unless replace is set', async () => {
  await withConfigDir(async () => {
    const capture = createFakeTmux({ sessions: ['work'] })
    const snapshot = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec: capture.exec,
    })
    const existing = createFakeTmux({ sessions: ['work'] })
    await assert.rejects(
      () =>
        restoreSnapshot({
          hostId: 'local',
          snapshotId: snapshot.id,
          exec: existing.exec,
          prepareAttach: async () => {},
        }),
      /already exists/,
    )
    assert.equal(
      existing.calls.some((args) => args[0] === 'kill-session'),
      false,
    )
    const replacing = createFakeTmux({ sessions: ['work'] })
    const result = await restoreSnapshot({
      hostId: 'local',
      snapshotId: snapshot.id,
      replace: true,
      exec: replacing.exec,
      prepareAttach: async () => {},
    })
    assert.equal(result.sessionName, 'work')
    assert.equal(
      replacing.calls.some((args) => args[0] === 'kill-session'),
      true,
    )
  })
})

for (const serverError of ['no-server', 'socket'] as const)
  test(`restore starts a fresh tmux server when none is running (${serverError})`, async () => {
    await withConfigDir(async () => {
      const capture = createFakeTmux({ sessions: ['work'] })
      const snapshot = await captureSessionSnapshot({
        hostId: 'local',
        sessionId: 'session-local-work',
        exec: capture.exec,
      })
      // 机器重启后首开网关：tmux server 根本没起来，任何子命令都是这句
      const fresh = createFakeTmux({ sessions: [] })
      let failedListSessions = false
      const calls: string[][] = []
      const exec = (async (hostId: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'list-sessions' && !failedListSessions) {
          failedListSessions = true
          // 两种真机形态：server 进程没了 vs 重启后 socket 文件都不在
          throw new Error(
            serverError === 'socket'
              ? 'Command failed: tmux list-sessions\nerror connecting to /tmp/tmux-1000/default (No such file or directory)\n'
              : 'Command failed: tmux list-sessions\nno server running on /tmp/tmux-1000/default\n',
          )
        }
        return (fresh.exec as unknown as (h: string, a: string[]) => Promise<{ stdout: string; stderr: string }>)(
          hostId,
          args,
        )
      }) as never
      const result = await restoreSnapshot({
        hostId: 'local',
        snapshotId: snapshot.id,
        exec,
        prepareAttach: async () => {},
      })
      assert.equal(result.sessionName, 'work')
      // 没有既有会话可杀；new-session 直接建出 server + 会话
      assert.equal(
        calls.some((args) => args[0] === 'kill-session'),
        false,
      )
      assert.equal(
        calls.some((args) => args[0] === 'new-session'),
        true,
      )
    })
  })

test('restore does not swallow transport failures as "no server"', async () => {
  await withConfigDir(async () => {
    const capture = createFakeTmux({ sessions: ['work'] })
    const snapshot = await captureSessionSnapshot({
      hostId: 'local',
      sessionId: 'session-local-work',
      exec: capture.exec,
    })
    const exec = (async (_hostId: string, args: string[]) => {
      if (args[0] === 'list-sessions') throw new Error('ssh: connect to host devbox port 22: Connection refused')
      return { stdout: '', stderr: '' }
    }) as never
    await assert.rejects(
      () => restoreSnapshot({ hostId: 'local', snapshotId: snapshot.id, exec, prepareAttach: async () => {} }),
      /Connection refused/,
    )
  })
})

test('restore throws for an unknown snapshot id', async () => {
  await withConfigDir(async () => {
    await assert.rejects(
      () => restoreSnapshot({ hostId: 'local', snapshotId: 'nope', exec: createFakeTmux().exec }),
      /Snapshot not found/,
    )
  })
})

test('shutdown capture covers local sessions, skips remote hosts and respects the deadline', async () => {
  await withConfigDir(async () => {
    const { exec } = createFakeTmux({ sessions: ['work', 'ops'] })
    const captured: string[] = []
    const result = await snapshotSessionsOnShutdown({
      hostIds: ['local', 'devbox'],
      exec,
      capture: (async (options: { sessionId: string }) => {
        captured.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' } as never
      }) as never,
    })
    assert.deepEqual(captured, ['session-local-work', 'session-local-ops'])
    assert.deepEqual(result.saved, ['local:work', 'local:ops'])
    assert.deepEqual(result.skipped, ['devbox:remote-host'])

    const empty = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      exec: (async () => {
        throw new Error('no server running')
      }) as unknown as TmuxExec,
    })
    // 没有 tmux server 属正常退出路径，不报错不阻塞
    assert.deepEqual(empty.saved, [])
  })
})

test('shutdown capture honours the session whitelist and records why the rest were skipped', async () => {
  await withConfigDir(async () => {
    const { exec } = createFakeTmux({ sessions: ['test', 'work', 'TmuxGo-1'] })
    const captured: string[] = []
    const result = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      include: ['test'],
      exec,
      capture: (async (options: { sessionId: string }) => {
        captured.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'test' } as never
      }) as never,
    })
    // 只抓白名单里的那个：生产机上关停不该连带扫别人的会话
    assert.deepEqual(captured, ['session-local-test'])
    assert.deepEqual(result.saved, ['local:test'])
    assert.deepEqual(result.skipped, ['local:work:not-in-whitelist', 'local:TmuxGo-1:not-in-whitelist'])

    // 白名单为空/未设 = 维持原行为（扫全部）
    const all: string[] = []
    const unrestricted = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      include: [],
      exec: createFakeTmux({ sessions: ['test', 'work'] }).exec,
      capture: (async (options: { sessionId: string }) => {
        all.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' } as never
      }) as never,
    })
    assert.deepEqual(all, ['session-local-test', 'session-local-work'])
    assert.deepEqual(unrestricted.skipped, [])

    // 白名单里的名字在当前 tmux 上不存在时不该报错（会话结束了而已）
    const missing = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      include: ['gone'],
      exec: createFakeTmux({ sessions: ['test'] }).exec,
      capture: (async () => {
        throw new Error('should not capture')
      }) as never,
    })
    assert.deepEqual(missing.saved, [])
    assert.deepEqual(missing.skipped, ['local:test:not-in-whitelist'])
  })
})

// 关停摘要走 warn：生产默认 level=warn，走 info 时白名单/跳过效果对运维不可见
test('shutdown snapshot summary is warn-level with a reason breakdown', () => {
  const skipped = [
    'devbox:remote-host',
    'local:work:not-in-whitelist',
    'local:ops:not-in-whitelist',
    'local:x:deadline',
  ]
  assert.deepEqual(summarizeSkipReasons(skipped), { 'remote-host': 1, 'not-in-whitelist': 2, deadline: 1 })

  const summary = describeShutdownSnapshots({ saved: ['local:test'], skipped })
  assert.equal(summary?.level, 'warn')
  assert.equal(summary?.payload.saved, 1)
  assert.equal(summary?.payload.skipped, 4)
  assert.deepEqual(summary?.payload.reasons, { 'remote-host': 1, 'not-in-whitelist': 2, deadline: 1 })

  // 只有 saved 也是 warn：运维要能从默认日志看到「这次关停抓到了什么」
  assert.equal(describeShutdownSnapshots({ saved: ['local:a'], skipped: [] })?.level, 'warn')
  // 全 0 是正常退出路径，不打日志
  assert.equal(describeShutdownSnapshots({ saved: [], skipped: [] }), null)
  // 明细限长，避免关停路径刷出长列表
  const many = describeShutdownSnapshots({ saved: Array.from({ length: 30 }, (_, i) => `local:s${i}`), skipped: [] })
  assert.equal((many?.payload.savedSessions as string[]).length, 10)
})

test('shutdown capture honours the exclude list as a hard veto', async () => {
  await withConfigDir(async () => {
    // 裸名：对所有 host 生效
    const all: string[] = []
    const bare = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      exclude: ['prod-secrets'],
      exec: createFakeTmux({ sessions: ['work', 'prod-secrets'] }).exec,
      capture: (async (options: { sessionId: string }) => {
        all.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' } as never
      }) as never,
    })
    assert.deepEqual(all, ['session-local-work'])
    assert.deepEqual(bare.saved, ['local:work'])
    assert.deepEqual(bare.skipped, ['local:prod-secrets:excluded'])

    // host:name 只挡指定 host，别的 host 上的同名 session 照抓
    const scoped: string[] = []
    const byHost = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      exclude: ['devbox:work', 'elsewhere:work'],
      exec: createFakeTmux({ sessions: ['work', 'ops'] }).exec,
      capture: (async (options: { sessionId: string }) => {
        scoped.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' } as never
      }) as never,
    })
    assert.deepEqual(scoped, ['session-local-work', 'session-local-ops'])
    assert.deepEqual(byHost.skipped, [])

    // include 与 exclude 同时存在：exclude 赢
    const both: string[] = []
    const combined = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      include: ['work', 'prod-secrets'],
      exclude: ['prod-secrets'],
      exec: createFakeTmux({ sessions: ['work', 'prod-secrets', 'other'] }).exec,
      capture: (async (options: { sessionId: string }) => {
        both.push(options.sessionId)
        return { id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' } as never
      }) as never,
    })
    assert.deepEqual(both, ['session-local-work'])
    assert.deepEqual(combined.saved, ['local:work'])
    assert.deepEqual(combined.skipped, ['local:prod-secrets:excluded', 'local:other:not-in-whitelist'])

    // 空/未配置：行为完全不变
    const untouched = await snapshotSessionsOnShutdown({
      hostIds: ['local'],
      exclude: [],
      exec: createFakeTmux({ sessions: ['work', 'ops'] }).exec,
      capture: (async () =>
        ({ id: 'x', panes: [], degraded: [], stats: {}, layout: {}, sessionName: 'work' }) as never) as never,
    })
    assert.deepEqual(untouched.saved, ['local:work', 'local:ops'])
    assert.deepEqual(untouched.skipped, [])
  })
})
