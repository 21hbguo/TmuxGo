import '../test-env.js'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  execHostShell,
  execTmux,
  normalizeTmuxEnvArgs,
  openVncSshTunnel,
  pickFreeLoopbackPort,
  tmuxSessionExists,
  verifyHostConnectivity,
} from './tmux-executor.js'
import { agentManager, type AgentSocket } from '../agent-manager.js'
import { getHostConnectivity } from './host-connectivity.js'
import { getTmuxEnvEntries } from './tmux-env.js'
import { detectTmuxVersion } from './security.js'
import { upsertRemoteHost, type HostInput } from './hosts.js'
import { installShims, lastShimArgs } from '../test-shims.js'
import { killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'

const execFileAsync = promisify(execFile)

// host.json 落在 TMUXGO_CONFIG_DIR：run-tests 给所有并行测试文件共用一个目录，
// 用例必须切到独立目录再写主机/凭据，避免跨文件串味
async function withHostStore(t: TestContext, hosts: HostInput[]) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-hosts-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  for (const host of hosts) await upsertRemoteHost(host)
}

// 私有 tmux server：test-tmux 约定共享 server 上只许用 test session，需要多 session/
// 特定名字的用例自建 socket 目录。收尾只用显式 -S kill-server，绝不碰默认 socket
function tmuxDirName(tmuxDir: string) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return path.join(tmuxDir, `tmux-${uid}`)
}
async function makeTmuxDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-exact-'))
  await mkdir(tmuxDirName(dir), { recursive: true, mode: 0o700 })
  return { dir, socket: path.join(tmuxDirName(dir), 'default') }
}
async function removeTmuxDir(dir: string, socket: string) {
  // server 退出与删目录存在竞态（socket/lock 会在遍历窗口内再现），rm 带重试
  await execFileAsync('tmux', ['-S', socket, 'kill-server']).catch(() => {})
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

// hasSshPass() 结果在模块级缓存且没有重置缝，本文件进程内的 sshpass 探测只能钉成 false：
// 该用例必须最先跑（PATH 指向不含 sshpass 的空目录），其余用例一律不得配置密码凭据。
// 「有 sshpass」一侧见 tmux-executor.sshpass.test.ts（独立进程，缓存从头解析）
test('verifyHostConnectivity reports missing sshpass before attempting SSH', async (t) => {
  await withHostStore(t, [
    { id: 'ssh-password-only', address: '192.0.2.110', user: 'dev', port: 22, password: 'pw-for-test' },
  ])
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-empty-bin-'))
  const previousPath = process.env.PATH
  process.env.PATH = emptyBin
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(emptyBin, { recursive: true, force: true })
  })
  assert.deepEqual(await verifyHostConnectivity('ssh-password-only'), {
    ok: false,
    message: 'sshpass is required for password auth',
    mode: 'password',
    code: 'AUTHENTICATION_ERROR',
  })
})

test('normalizes -e TMUXGO_ENV=1 into setenv fallback without touching other -e flags', () => {
  assert.deepEqual(normalizeTmuxEnvArgs(['new-session', '-d', '-s', 'name', '-e', 'TMUXGO_ENV=1']), {
    args: ['new-session', '-d', '-s', 'name'],
    needsSetEnv: true,
    markerIndex: 4,
  })
  assert.deepEqual(
    normalizeTmuxEnvArgs(['split-window', '-c', '#{pane_current_path}', '-e', 'TMUXGO_ENV=1', '-t', '%1', '-h']),
    { args: ['split-window', '-c', '#{pane_current_path}', '-t', '%1', '-h'], needsSetEnv: true, markerIndex: 3 },
  )
  assert.deepEqual(normalizeTmuxEnvArgs(['capture-pane', '-e', '-p', '-t', '%1']), {
    args: ['capture-pane', '-e', '-p', '-t', '%1'],
    needsSetEnv: false,
    markerIndex: -1,
  })
  assert.deepEqual(normalizeTmuxEnvArgs(['list-sessions']), {
    args: ['list-sessions'],
    needsSetEnv: false,
    markerIndex: -1,
  })
})

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
test('executes local tmux and shell commands through the local host', async () => {
  const sessionName = TEST_TMUX_SESSION
  try {
    const tmux = await execTmux('local', [
      'new-session',
      '-d',
      '-s',
      sessionName,
      'sh',
      '-lc',
      'printf agent; sleep 30',
    ])
    assert.equal(tmux.host.id, 'local')
    const panes = await execTmux('local', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    assert.match(panes.stdout, /^%\d+\n?$/)
    const shell = await execHostShell('local', 'printf shell')
    assert.equal(shell.host.id, 'local')
    assert.equal(shell.stdout, 'shell')
  } finally {
    await killTestTmuxSession()
  }
})

test('injects TMUXGO_ENV via setenv when new-session uses the legacy -e form', async () => {
  const sessionName = TEST_TMUX_SESSION
  const marker = path.join(os.tmpdir(), `tmuxgo-env-${process.pid}-${Date.now()}`)
  try {
    await execTmux('local', [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-e',
      'TMUXGO_ENV=1',
      'sh',
      '-lc',
      `printf '%s' "$TMUXGO_ENV" > '${marker}'`,
    ])
    let content = ''
    for (let i = 0; i < 20 && !content; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      content = await readFile(marker, 'utf8').catch(() => '')
    }
    assert.equal(content, '1')
  } finally {
    await killTestTmuxSession()
    await rm(marker, { force: true }).catch(() => {})
  }
})

test('creates session via cold start when tmux server is missing (setenv tolerated)', async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-cold-'))
  const sessionName = TEST_TMUX_SESSION
  const previousTmpDir = process.env.TMUX_TMPDIR
  process.env.TMUX_TMPDIR = tmpDir
  t.after(async () => {
    if (previousTmpDir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = previousTmpDir
    // server 退出/客户端启停收尾与删除目录存在竞态：遍历窗口内 socket/lock 文件
    // 可能再现（ENOTEMPTY），rm 带重试收口
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  try {
    await execTmux('local', ['new-session', '-d', '-s', sessionName, '-e', 'TMUXGO_ENV=1'])
    const panes = await execTmux('local', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
    assert.match(panes.stdout, /^%\d+\n?$/)
    const env = await execTmux('local', ['show-environment', '-g', 'TMUXGO_ENV'])
    assert.match(env.stdout.trim(), /^TMUXGO_ENV=1$/)
  } finally {
    // TMUX_TMPDIR 此刻仍指向本用例私有目录：kill 的是冷启动 server 上的 test
    await killTestTmuxSession()
  }
})

test('routes tmux and shell scans through an Agent host', async () => {
  const hostId = `agent-executor-${process.pid}-${Date.now()}`
  const messages: string[] = []
  const socket = {
    readyState: 1,
    send: (message: string) => {
      messages.push(message)
      const request = JSON.parse(message)
      if (request.type === 'tmux')
        void Promise.resolve().then(() =>
          agentManager.handleMessage(hostId, socket, {
            type: 'tmux-result',
            requestId: request.requestId,
            stdout: 'agent-pane\n',
            stderr: '',
          }),
        )
      if (request.type === 'shell')
        void Promise.resolve().then(() =>
          agentManager.handleMessage(hostId, socket, {
            type: 'shell-result',
            requestId: request.requestId,
            stdout: 'agent-shell',
            stderr: '',
            exitCode: 0,
          }),
        )
    },
  } as unknown as AgentSocket /* 桩：只实现测试用到的 readyState/send，on/close 由注册路径不用 */
  agentManager.register(hostId, 'agent-host', '127.0.0.1', '1.0.0', socket)
  const tmux = await execTmux(hostId, ['list-panes'])
  const shell = await execHostShell(hostId, 'printf shell')
  assert.equal(tmux.host.id, hostId)
  assert.equal(tmux.stdout, 'agent-pane\n')
  assert.equal(shell.host.id, hostId)
  assert.equal(shell.stdout, 'agent-shell')
  assert.deepEqual(
    messages.map((message) => JSON.parse(message).type),
    ['tmux', 'shell'],
  )
  assert.equal(agentManager.unregister(hostId, socket), true)
})

test('normalizes an unavailable SSH host for tmux and shell execution', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-ssh-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(configDir, { recursive: true, force: true })
  })
  await upsertRemoteHost({ id: 'ssh-unavailable', address: '127.0.0.1', user: 'nobody', port: 1 })
  await assert.rejects(
    execTmux('ssh-unavailable', ['list-panes'], { timeoutMs: 1000 }),
    /SSH connection timed out|SSH network is unreachable|Connection refused/,
  )
  await assert.rejects(
    execHostShell('ssh-unavailable', 'printf shell', { timeoutMs: 1000 }),
    /SSH connection timed out|SSH network is unreachable|Connection refused/,
  )
  // ssh 目标不可达时隧道应立即失败而不是挂到超时
  await assert.rejects(
    openVncSshTunnel('ssh-unavailable', 5900),
    /SSH network is unreachable|Connection refused|SSH tunnel failed/,
  )
})

test('pickFreeLoopbackPort skips occupied ports', async () => {
  const busy = await pickFreeLoopbackPort()
  assert.ok(busy)
  const blocker = (await import('node:net')).createServer()
  await new Promise<void>((resolve) => blocker.listen(busy, '127.0.0.1', resolve))
  try {
    const next = await pickFreeLoopbackPort(busy, busy)
    assert.equal(next, null)
    const after = await pickFreeLoopbackPort(busy + 1)
    assert.ok(after === null || after > busy)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

// ---- verifyHostConnectivity：UI「连接测试」的分类码全靠这条路径，分支多且都是错误路径 ----

test('verifyHostConnectivity resolves the local host and rejects unusable host ids', async () => {
  assert.deepEqual(await verifyHostConnectivity('local'), {
    ok: true,
    message: 'local host available',
    mode: 'local',
  })
  await assert.rejects(verifyHostConnectivity('   '), /Missing host id/)
  await assert.rejects(verifyHostConnectivity('no-such-host'), /Host "no-such-host" not found/)
})

test('verifyHostConnectivity reports agent channel state instead of ssh for agent hosts', async (t) => {
  const hostId = `verify-agent-${process.pid}-${Date.now()}`
  const socket = { readyState: 1, send: () => {} } as unknown as AgentSocket /* 桩：只用到 readyState */
  agentManager.register(hostId, 'verify-agent', '127.0.0.1', '1.0.0', socket)
  t.after(() => agentManager.unregister(hostId, socket))
  assert.deepEqual(await verifyHostConnectivity(hostId), { ok: true, message: 'agent ready', mode: 'agent' })
  // 心跳过期后 getAgent 仍返回记录但 online=false：要报「未连接」，不能退化成「主机不存在」
  const realNow = Date.now
  Date.now = () => realNow() + 120_000
  try {
    await assert.rejects(verifyHostConnectivity(hostId), /Agent ".*" is not connected/)
  } finally {
    Date.now = realNow
  }
})

test('verifyHostConnectivity classifies every known ssh failure marker', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  const hostId = 'ssh-matrix'
  await withHostStore(t, [{ id: hostId, address: '192.0.2.110', user: 'dev', port: 22, useAgent: false }])
  const cases = [
    ['Host key verification failed.', 'Host key verification failed', 'HOST_KEY_ERROR'],
    ['@@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@', 'Host key verification failed', 'HOST_KEY_ERROR'],
    ['ssh: connect to host 192.0.2.110 port 22: Connection timed out', 'SSH connection timed out', 'NETWORK_ERROR'],
    ['ssh: No route to host', 'SSH connection timed out', 'NETWORK_ERROR'],
    [
      'ssh: Could not resolve hostname devbox: Name or service not known',
      'SSH network is unreachable',
      'NETWORK_ERROR',
    ],
    ['ssh: connect to host 192.0.2.110 port 22: Connection refused', 'SSH network is unreachable', 'NETWORK_ERROR'],
    ['dev@192.0.2.110: Permission denied (publickey,password).', 'SSH authentication failed', 'AUTHENTICATION_ERROR'],
    ['Load key "/home/user/.ssh/id_ed25519": invalid format', 'SSH private key is unavailable', 'AUTHENTICATION_ERROR'],
    ['bash: line 1: tmux: command not found', 'tmux is not installed on target host', 'CONNECTION_ERROR'],
    // 优先级：同一条 stderr 里既有 host key 又有认证标记时按 host key 归类（前者的处置动作不同）
    ['Host key verification failed.\nPermission denied (publickey).', 'Host key verification failed', 'HOST_KEY_ERROR'],
  ] as const
  for (const [stderr, message, code] of cases) {
    process.env.SHIM_SSH_STDERR = stderr
    process.env.SHIM_SSH_EXIT = '255'
    assert.deepEqual(await verifyHostConnectivity(hostId), { ok: false, message, mode: 'key', code }, stderr)
  }
  // 未识别的 stderr 原样透出（不能凭空归类）
  process.env.SHIM_SSH_STDERR = 'ssh: some brand new failure mode'
  assert.deepEqual(await verifyHostConnectivity(hostId), {
    ok: false,
    message: 'ssh: some brand new failure mode',
    mode: 'key',
    code: 'CONNECTION_ERROR',
  })
  // 已知失败（远端 tmux 通道）要把主机标记成 offline——UI 主机红点靠这条记录；
  // 未识别的消息不得凭空记成连接失败
  process.env.SHIM_SSH_STDERR = 'dev@192.0.2.110: Permission denied (publickey).'
  await assert.rejects(execTmux(hostId, ['list-panes']), /SSH authentication failed/)
  assert.equal(getHostConnectivity(hostId)?.status, 'offline')
  assert.equal(getHostConnectivity(hostId)?.lastError, 'SSH authentication failed')
  process.env.SHIM_SSH_STDERR = 'ssh: some brand new failure mode'
  await assert.rejects(execTmux(hostId, ['list-panes']), /some brand new failure mode/)
  assert.equal(getHostConnectivity(hostId)?.lastError, 'SSH authentication failed')
})

test('verifyHostConnectivity reports ssh ready together with the credential mode', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withHostStore(t, [
    { id: 'ssh-agent-mode', address: '192.0.2.111', user: 'dev', port: 22 },
    { id: 'ssh-key-mode', address: '192.0.2.112', user: 'dev', port: 22, useAgent: false },
    {
      id: 'ssh-keyfile-mode',
      address: '192.0.2.113',
      user: 'dev',
      port: 22,
      useAgent: false,
      privateKeyPath: '/home/user/.ssh/id_ed25519',
    },
  ])
  process.env.SHIM_SSH_STDOUT = 'tmuxgo-ok\n'
  process.env.SHIM_SSH_EXIT = '0'
  assert.deepEqual(await verifyHostConnectivity('ssh-agent-mode'), { ok: true, message: 'ssh ready', mode: 'agent' })
  assert.deepEqual(await verifyHostConnectivity('ssh-key-mode'), { ok: true, message: 'ssh ready', mode: 'key' })
  assert.deepEqual(await verifyHostConnectivity('ssh-keyfile-mode'), { ok: true, message: 'ssh ready', mode: 'key' })
  const args = lastShimArgs(shims, 'ssh') ?? []
  assert.deepEqual(
    args.filter((arg) => arg === '-i' || arg.startsWith('/home/user/')),
    ['-i', '/home/user/.ssh/id_ed25519'],
  )
  assert.ok(args.includes('BatchMode=yes'), '探活必须非交互')
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'))
  assert.equal(args.at(-1), 'echo tmuxgo-ok')
  // 连上了但回显不是约定串（远端 profile 会污染 stdout）：判认证失败，不得当 ready
  process.env.SHIM_SSH_STDOUT = 'bash: /etc/profile: Permission denied\n'
  assert.deepEqual(await verifyHostConnectivity('ssh-key-mode'), {
    ok: false,
    message: 'SSH authentication failed',
    mode: 'key',
    code: 'AUTHENTICATION_ERROR',
  })
})

// ---- tmuxSessionExists：'=' 精确匹配是防止 session-a/session-ab 串台的关键 ----

test('tmuxSessionExists matches session names exactly instead of by prefix', async (t) => {
  const { dir, socket } = await makeTmuxDir()
  const previousTmpDir = process.env.TMUX_TMPDIR
  process.env.TMUX_TMPDIR = dir
  t.after(async () => {
    if (previousTmpDir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = previousTmpDir
    await removeTmuxDir(dir, socket)
  })
  await execTmux('local', ['new-session', '-d', '-s', 'session-a'])
  assert.equal(await tmuxSessionExists('local', 'session-a'), true)
  assert.equal(await tmuxSessionExists('local', 'session-ab'), false)
  // 裸 -t 对唯一前缀会命中：先证明裸调用确实命中，false 才说明是 '=' 起了作用
  const bareHit = await execFileAsync('tmux', ['-S', socket, 'has-session', '-t', 'sess']).then(
    () => true,
    () => false,
  )
  assert.equal(bareHit, true)
  assert.equal(await tmuxSessionExists('local', 'sess'), false)
  // 两个同前缀会话并存时，前缀查询必须仍然不命中
  await execTmux('local', ['new-session', '-d', '-s', 'session-ab'])
  assert.equal(await tmuxSessionExists('local', 'session-a'), true)
  assert.equal(await tmuxSessionExists('local', 'session-ab'), true)
  assert.equal(await tmuxSessionExists('local', 'session'), false)
})

// ---- 版本/启动器分支：都依赖宿主真实能力，不伪造 tmux 二进制 ----

test('cold start goes through systemd-run --scope when INVOCATION_ID is set', async (t) => {
  let realSystemdRun: string
  try {
    realSystemdRun = (await execFileAsync('sh', ['-c', 'command -v systemd-run'])).stdout.trim()
  } catch {
    realSystemdRun = ''
  }
  if (!realSystemdRun) {
    t.skip('systemd-run not installed on this host')
    return
  }
  // --user 需要用户会话总线；沙箱/容器里通常没有，探测失败就跳过而不是伪造
  const scopeUsable = await execFileAsync(realSystemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    process.execPath,
    '-e',
    '',
  ]).then(
    () => true,
    () => false,
  )
  if (!scopeUsable) {
    t.skip('systemd-run --user --scope unavailable (no user session bus)')
    return
  }
  const shims = installShims(['systemd-run'], { systemdRunPath: realSystemdRun })
  t.after(shims.restore)
  const { dir, socket } = await makeTmuxDir()
  const previousTmpDir = process.env.TMUX_TMPDIR
  const previousInvocation = process.env.INVOCATION_ID
  process.env.TMUX_TMPDIR = dir
  t.after(async () => {
    if (previousTmpDir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = previousTmpDir
    if (previousInvocation === undefined) delete process.env.INVOCATION_ID
    else process.env.INVOCATION_ID = previousInvocation
    await removeTmuxDir(dir, socket)
  })
  process.env.INVOCATION_ID = 'tmuxgo-test-invocation'
  await execTmux('local', ['new-session', '-d', '-s', 'scope-cold'])
  assert.equal(shims.count('systemd-run'), 1, 'new-session 在 systemd 环境里必须换 systemd-run 启动')
  const scopeArgs = lastShimArgs(shims, 'systemd-run') ?? []
  assert.deepEqual(scopeArgs.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', 'tmux'])
  assert.deepEqual(scopeArgs.slice(5), ['new-session', '-d', '-s', 'scope-cold'])
  assert.equal(await tmuxSessionExists('local', 'scope-cold'), true)
  // 无 INVOCATION_ID（普通终端启动）时不得套 scope，否则无 systemd 的宿主会直接不可用
  delete process.env.INVOCATION_ID
  await execTmux('local', ['new-session', '-d', '-s', 'scope-plain'])
  assert.equal(shims.count('systemd-run'), 1)
  assert.equal(await tmuxSessionExists('local', 'scope-plain'), true)
})

test('inline -e carries TMUXGO_* into the first pane of a brand-new server', async (t) => {
  const version = await detectTmuxVersion()
  const match = version?.match(/(\d+)\.(\d+)/)
  const inlineSupported = !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 2))
  if (!inlineSupported) {
    t.skip(`host tmux ${version ?? 'unknown'} < 3.2: inline -e unsupported, setenv fallback is the only path`)
    return
  }
  const entries = new Map(
    getTmuxEnvEntries('local').map((entry) => [
      entry.slice(0, entry.indexOf('=')),
      entry.slice(entry.indexOf('=') + 1),
    ]),
  )
  // tmux server 起始时把客户端环境收成全局环境：跑测试的进程常年带着 TMUXGO_ENV /
  // TMUXGO_GATEWAY_URL（gateway 自己就在带标记的 pane 里），不清掉「pane 看到了变量」会假阳性
  const inheritedEnv: Record<string, string | undefined> = {
    TMUXGO_ENV: process.env.TMUXGO_ENV,
    TMUXGO_GATEWAY_URL: process.env.TMUXGO_GATEWAY_URL,
  }
  delete process.env.TMUXGO_ENV
  delete process.env.TMUXGO_GATEWAY_URL
  t.after(() => {
    for (const [key, value] of Object.entries(inheritedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const dirs = [await makeTmuxDir(), await makeTmuxDir()]
  const previousTmpDir = process.env.TMUX_TMPDIR
  t.after(async () => {
    if (previousTmpDir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = previousTmpDir
    for (const { dir, socket } of dirs) await removeTmuxDir(dir, socket)
  })
  // 对照：全新 server 上不带 -e 的首个 pane 拿不到 TMUXGO_*（server 零 session 时
  // setenv -g 活不过 exit-empty），所以下面的非空结果只能来自 inline -e
  const plainMarker = path.join(os.tmpdir(), `tmuxgo-inline-plain-${process.pid}-${Date.now()}`)
  const inlineMarker = path.join(os.tmpdir(), `tmuxgo-inline-env-${process.pid}-${Date.now()}`)
  t.after(async () => {
    await rm(plainMarker, { force: true }).catch(() => {})
    await rm(inlineMarker, { force: true }).catch(() => {})
  })
  const readMarker = async (file: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const content = await readFile(file, 'utf8').catch(() => '')
      if (content) return content
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return ''
  }
  process.env.TMUX_TMPDIR = dirs[0].dir
  await execTmux('local', [
    'new-session',
    '-d',
    '-s',
    'plain',
    'sh',
    '-lc',
    `printf '%s' "\${TMUXGO_ENV:-}|x" > '${plainMarker}'; sleep 5`,
  ])
  assert.equal(await readMarker(plainMarker), '|x')
  process.env.TMUX_TMPDIR = dirs[1].dir
  await execTmux('local', [
    'new-session',
    '-d',
    '-s',
    'inline',
    '-e',
    'TMUXGO_ENV=1',
    'sh',
    '-lc',
    `printf '%s|%s' "\${TMUXGO_ENV:-}" "\${TMUXGO_GATEWAY_URL:-}" > '${inlineMarker}'; sleep 5`,
  ])
  assert.equal(await readMarker(inlineMarker), `1|${entries.get('TMUXGO_GATEWAY_URL') ?? ''}`)
})
