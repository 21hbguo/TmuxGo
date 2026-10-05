import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { createTerminalAttachment, setAttachFlagProbeForTest, setPtySpawnForTest } from './terminal-attachment.js'
import { TEST_TMUX_SESSION, execTmuxFile, killTestTmuxSession } from '../test-tmux.js'
import { upsertRemoteHost } from './hosts.js'
import { agentManager } from '../agent-manager.js'

function fakePty(pid: number) {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []
  return {
    pid,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    write: () => {},
    resize: () => {},
    kill: () => {},
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
  } as IPty & { emitData: (data: string) => void; emitExit: (exitCode: number) => void }
}
function withConfigDir(t: { after: (fn: () => void | Promise<void>) => void }) {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  return async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-attach-'))
    process.env.TMUXGO_CONFIG_DIR = configDir
    t.after(async () => {
      if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
      else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    })
  }
}
test('creates a remote SSH attachment with expected ssh arguments', async (t) => {
  await withConfigDir(t)()
  setAttachFlagProbeForTest(async () => true)
  t.after(() => setAttachFlagProbeForTest(null))
  await upsertRemoteHost({
    id: 'remote',
    address: 'remote.example',
    user: 'guo',
    port: 2222,
    privateKeyPath: '/home/user/.ssh/id_ed25519',
  })
  const spawned: Array<{ file: string; args: string[] }> = []
  const fakes: Array<ReturnType<typeof fakePty>> = []
  setPtySpawnForTest((file, args, _options) => {
    spawned.push({ file, args })
    const fake = fakePty(100)
    fakes.push(fake)
    return fake
  })
  const attachment = await createTerminalAttachment({
    hostId: 'remote',
    sessionName: 'dev',
    cols: 100,
    rows: 30,
    exclusive: false,
  })
  assert.equal(attachment.pid, 100)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'ssh')
  assert.ok(spawned[0].args.includes('-p'))
  assert.ok(spawned[0].args.includes('2222'))
  assert.ok(spawned[0].args.includes('guo@remote.example'))
  assert.ok(spawned[0].args.includes('-i'))
  assert.ok(spawned[0].args.includes('/home/user/.ssh/id_ed25519'))
  assert.ok(spawned[0].args.includes('StrictHostKeyChecking=accept-new'))
  assert.ok(spawned[0].args.includes('tmux'))
  assert.ok(spawned[0].args.includes('attach'))
  assert.ok(spawned[0].args.includes('-f'))
  assert.ok(spawned[0].args.includes('ignore-size'))
  assert.ok(!spawned[0].args.includes('ignore-size,active-pane'))
  assert.ok(spawned[0].args.includes('-t'))
  assert.ok(spawned[0].args.includes('dev'))
  attachment.kill()
})
test('drops -f ignore-size when the remote tmux is below 3.2', async (t) => {
  await withConfigDir(t)()
  setAttachFlagProbeForTest(async () => false)
  t.after(() => setAttachFlagProbeForTest(null))
  await upsertRemoteHost({
    id: 'remote-old-tmux',
    address: 'remote-old.example',
    user: 'guo',
    port: 22,
  })
  const spawned: Array<{ file: string; args: string[] }> = []
  setPtySpawnForTest((file, args, _options) => {
    spawned.push({ file, args })
    return fakePty(101)
  })
  const attachment = await createTerminalAttachment({
    hostId: 'remote-old-tmux',
    sessionName: 'dev',
    cols: 100,
    rows: 30,
    exclusive: false,
  })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'ssh')
  assert.ok(spawned[0].args.includes('attach'))
  assert.ok(!spawned[0].args.includes('-f'))
  attachment.kill()
})
test('creates a local tmux attachment and adapts pty events', async () => {
  const spawned: Array<{ file: string; args: string[] }> = []
  const fakes: Array<ReturnType<typeof fakePty>> = []
  setPtySpawnForTest((file, args, _options) => {
    spawned.push({ file, args })
    const fake = fakePty(200)
    fakes.push(fake)
    return fake
  })
  const attachment = await createTerminalAttachment({
    hostId: 'local',
    sessionName: 'work',
    cols: 120,
    rows: 40,
    exclusive: true,
  })
  assert.equal(attachment.pid, 200)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'tmux')
  assert.ok(spawned[0].args.includes('attach'))
  assert.ok(spawned[0].args.includes('-t'))
  assert.ok(spawned[0].args.includes('work'))
  assert.ok(!spawned[0].args.includes('-f'))
  let output = ''
  attachment.onData((chunk) => {
    output += chunk
  })
  let exitCode: number | null = null
  attachment.onExit((code) => {
    exitCode = code
  })
  fakes[0].emitData('pane-output')
  fakes[0].emitExit(5)
  assert.equal(output, 'pane-output')
  assert.equal(exitCode, 5)
  attachment.kill()
})
test('creates an agent attachment and adapts onExit to a plain exit code', async (t) => {
  await withConfigDir(t)()
  const hostId = `agent-attach-${process.pid}-${Date.now()}`
  let attachmentId = ''
  const socket = {
    readyState: 1,
    send: (message: string) => {
      const request = JSON.parse(message)
      if (request.type === 'terminal-attach') {
        attachmentId = request.attachmentId
        void Promise.resolve().then(() =>
          agentManager.handleMessage(hostId, socket as any, {
            type: 'terminal-attached',
            requestId: request.requestId,
            attachmentId: request.attachmentId,
            pid: 4242,
          }),
        )
      }
    },
  } as any
  agentManager.register(hostId, 'agent-host', '127.0.0.1', '1.0.0', socket)
  const attachment = await createTerminalAttachment({
    hostId,
    sessionName: 'dev',
    cols: 80,
    rows: 24,
    exclusive: false,
  })
  assert.equal(attachment.pid, 4242)
  let exitCode: number | null = null
  attachment.onExit((code) => {
    exitCode = code
  })
  agentManager.handleMessage(hostId, socket, { type: 'terminal-exit', attachmentId, exitCode: 7 })
  assert.equal(exitCode, 7)
  assert.equal(agentManager.unregister(hostId, socket), true)
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('shared attach input follows window active pane after a mouse claim', async (t) => {
  // 回归：attach 曾带 -f active-pane，client 经鼠标点击后私记活动 pane
  // （cw->pane）。此后 CLI select-pane（api.panes.select 等价路径）只能改
  // window->active（CLI 的 cmdq client session 为 NULL，恒走
  // window_set_active_pane 分支）——该 client 的输入继续钉在旧 pane，
  // 而 UI 的 pane_active 快照已指向新 pane。摘掉 flag 后 client 无私有
  // pane，输入恒跟随 window->active，三处语义收敛一致。
  const prevTmuxEnv = process.env.TMUX
  delete process.env.TMUX // spawn 的 tmux 继承 process.env；TMUX 会覆盖 TMUX_TMPDIR 路由到用户 server
  const realSpawn = (file: string, args: string[], options: pty.IPtyForkOptions) => pty.spawn(file, args, options)
  setPtySpawnForTest(realSpawn)
  setAttachFlagProbeForTest(async () => true)
  t.after(() => {
    if (prevTmuxEnv === undefined) delete process.env.TMUX
    else process.env.TMUX = prevTmuxEnv
    setPtySpawnForTest(realSpawn)
    setAttachFlagProbeForTest(null)
  })
  await killTestTmuxSession()
  // pane 直接跑 cat：输入路由的裸验证，避开 shell 补全/折行重绘干扰
  await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '160', '-y', '48', 'cat'])
  await execTmuxFile('tmux', ['split-window', '-t', TEST_TMUX_SESSION, '-h', 'cat'])
  await execTmuxFile('tmux', ['set', '-g', 'mouse', 'on'])
  t.after(async () => {
    await killTestTmuxSession()
    await execTmuxFile('tmux', ['set', '-gu', 'mouse']).catch(() => {})
  })
  const { stdout } = await execTmuxFile('tmux', [
    'list-panes',
    '-t',
    TEST_TMUX_SESSION,
    '-F',
    '#{pane_left} #{pane_id}',
  ])
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [left, id] = line.split(' ')
      return { left: Number(left), id }
    })
  const pLeft = rows.find((row) => row.left === 0)!.id
  const pRight = rows.find((row) => row.left > 0)!.id
  // 模拟 web attach client（走待测代码路径）与并存的真实终端 client
  const realClient = pty.spawn('tmux', ['attach', '-t', TEST_TMUX_SESSION], {
    name: 'xterm-256color',
    cols: 160,
    rows: 48,
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  realClient.onData(() => {})
  t.after(() => realClient.kill())
  const attachment = await createTerminalAttachment({
    hostId: 'local',
    sessionName: TEST_TMUX_SESSION,
    cols: 160,
    rows: 48,
    exclusive: false,
  })
  t.after(() => attachment.kill())
  await sleep(800)
  const capture = async (pane: string) =>
    (await execTmuxFile('tmux', ['capture-pane', '-pt', pane, '-p'])).stdout.replace(/\s/g, '')
  // pane 切换瞬间 client 输入侧偶发丢头字节（隔离 server 实测抖动），
  // 重试到 marker 完整落入某个 pane 再判路由
  const writeUntilSeen = async (data: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      attachment.write(data)
      await sleep(400)
      const l = await capture(pLeft)
      const r = await capture(pRight)
      if (l.includes(data) || r.includes(data)) return { leftCap: l, rightCap: r }
    }
    return { leftCap: await capture(pLeft), rightCap: await capture(pRight) }
  }
  // 注意：点击的目标必须与该 client 当前活动 pane 不同——相同时
  // select-pane 命中 wp==activewp 早退，不会产生私有 claim。
  // split-window 后 window->active 是右 pane，所以点击左 pane 形成 claim
  // （带 active-pane flag 时输入将钉死在左 pane）
  attachment.write('\x1b[<0;20;10M\x1b[<0;20;10m')
  await sleep(300)
  const { leftCap: capAfterClick } = await writeUntilSeen('MARK_L')
  assert.match(capAfterClick, /MARK_L/)
  // 真实终端随后也有输入（并存 client 的正常活动）
  realClient.write(' ')
  await sleep(200)
  // api.panes.select 等价路径：CLI select-pane → window->active=右 pane。
  // 带 active-pane flag 的 client 私记左 pane 不变——输入仍落左 pane
  await execTmuxFile('tmux', ['select-pane', '-t', pRight])
  await sleep(300)
  const { leftCap, rightCap } = await writeUntilSeen('MARK_R')
  assert.match(rightCap, /MARK_R/)
  assert.doesNotMatch(leftCap, /MARK_R/)
})
