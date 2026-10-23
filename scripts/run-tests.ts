import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { prepareTmuxSocketDir, tmuxSocketPath, tmuxTestEnv } from './tmux-isolation'

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    console.error(`Unsupported Node.js ${process.version}. Need ^20.19 || ^22.12 || >=24 (nvm use with .nvmrc)`)
    process.exit(1)
  }
}

function collectTests(dir: string, acc: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      collectTests(fullPath, acc)
      continue
    }
    if (/\.(test|spec)\.tsx?$/.test(entry)) {
      acc.push(fullPath)
    }
  }
  return acc
}

assertSupportedNode()

const root = process.cwd()
// 起 test server 的引导 session 名（设完 exit-empty 即删，测试不可见）
const TEST_SERVER_BOOTSTRAP_SESSION = '__tmuxgo_test_bootstrap__'
// 可选过滤：`pnpm test <路径子串>…` 只跑匹配文件。跑单文件一律走这里——
// 自造 TMUX/TMUX_TMPDIR env 直跑 tsx --test 曾漏清 TMUX，kill-server 误杀
// 用户默认 server（TMUX 已设置时 tmux 忽略 TMUX_TMPDIR）
// 分层开关：`pnpm test --fast`（或 TMUXGO_TEST_FAST=1）只跑快层——跳过用 slowSkip
// 标记的等待型用例（单次 >2s 的心跳/TTL/真子进程）和整组真 tmux 串行文件；
// 不带参数/CI 一律全量，行为与分层前完全一致
const args = process.argv.slice(2)
const fastMode = args.includes('--fast') || process.env.TMUXGO_TEST_FAST === '1'
const patterns = args.filter((arg) => arg !== '--fast')
const collected = collectTests(join(root, 'apps/gateway/src')).concat(collectTests(join(root, 'tests')))
const files = patterns.length ? collected.filter((f) => patterns.some((p) => f.includes(p))) : collected
if (files.length === 0) {
  console.error(patterns.length ? `No test files match: ${patterns.join(', ')}` : 'No test files found')
  process.exit(1)
}

// 真实 tmux 用例共享隔离 server 上的 test session：识别方式 = import test-tmux
// 约定模块 / 直接 spawn tmux CLI / 走 execTmux 执行器。这些文件跨文件并发会
// 互踩同一 session（node --test 默认按文件并行），必须逐文件串行跑
const realTmuxUsage = /test-tmux|\(\s*['"]tmux['"]\s*,|\bexecTmux\(/
const serialFiles: string[] = []
const parallelFiles: string[] = []
for (const file of files) {
  ;(realTmuxUsage.test(readFileSync(file, 'utf8')) ? serialFiles : parallelFiles).push(file)
}
// 快层不跑真 tmux 串行组：这批就是"真起会话"的集成文件，也是串行段的主要墙钟来源
const skippedSerialFiles = fastMode ? serialFiles.splice(0, serialFiles.length) : []
if (fastMode) process.env.TMUXGO_TEST_FAST = '1'
console.log(`collected ${files.length} test files (${serialFiles.length} serial tmux)`)
if (fastMode)
  console.log(
    `FAST mode: skip ${skippedSerialFiles.length} real-tmux files and @slow cases (slowSkip) — full run: pnpm test`,
  )

// Isolate unit-test side effects away from the real ~/.tmuxgo config dir.
const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
const previousTmpDir = process.env.TMUXGO_TMP_DIR
const previousTmux = process.env.TMUX
const previousTmuxTmpDir = process.env.TMUX_TMPDIR
const previousTmuxIsolated = process.env.TMUXGO_TEST_TMUX_ISOLATED
const previousInvocationId = process.env.INVOCATION_ID
const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-unit-tests-'))
// 测试专用 tmux server：独立 socket 目录，清空 TMUX 避免继承外层 pane 的
// socket 路径（run-e2e.ts 同款做法）。直接命令与应用子进程走同一 server
const tmuxDir = mkdtempSync(join(tmpdir(), 'tmuxgo-test-tmux-'))
prepareTmuxSocketDir(tmuxDir)
// 固定 server 生命周期：默认 exit-empty on 时最后一个 session 消失 server 就退出，
// 于是每个用例边界都在起停 server——客户端恰好撞上退出窗口会报
// "server exited unexpectedly"，socket/lock 文件也会在删目录窗口内再现（ENOTEMPTY）。
// 这里起 server 后关掉 exit-empty：session 归零 server 仍在，用例边界零起停。
// 引导用一次性 session，设完选项立刻删掉，不留可见 session
if (!fastMode)
  spawnSync(
    'tmux',
    [
      '-S',
      tmuxSocketPath(tmuxDir),
      'new-session',
      '-d',
      '-s',
      TEST_SERVER_BOOTSTRAP_SESSION,
      ';',
      'set-option',
      '-s',
      'exit-empty',
      'off',
      ';',
      'kill-session',
      '-t',
      TEST_SERVER_BOOTSTRAP_SESSION,
    ],
    { stdio: 'ignore', env: tmuxTestEnv(tmuxDir) },
  )
process.env.TMUXGO_CONFIG_DIR = configDir
process.env.TMUXGO_PREFERENCES_DIR = join(configDir, 'preferences')
process.env.TMUXGO_TMP_DIR = join(configDir, 'tmp')
process.env.TMUX = ''
process.env.TMUX_TMPDIR = tmuxDir
// test-tmux.ts 据此确认处于隔离 server（用户 shell 自带 TMUX_TMPDIR 不误判）
process.env.TMUXGO_TEST_TMUX_ISOLATED = '1'
// INVOCATION_ID 是 systemd 注入的：泄漏进测试会让 tmux-executor 把 new-session
// 包进 `systemd-run --user --scope`（生产下让会话脱离 gateway unit 的 cgroup），
// 该路径在负载下可达 30s 超时。测试一律走裸 tmux，结果与宿主 init 系统无关
delete process.env.INVOCATION_ID

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  // 只 kill 测试专用 server（独立 socket 目录内）；禁止默认 socket kill-server
  spawnSync('tmux', ['-S', tmuxSocketPath(tmuxDir), 'kill-server'], { stdio: 'ignore', env: tmuxTestEnv(tmuxDir) })
  if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
  else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
  if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
  else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
  if (previousTmpDir === undefined) delete process.env.TMUXGO_TMP_DIR
  else process.env.TMUXGO_TMP_DIR = previousTmpDir
  if (previousTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = previousTmux
  if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR
  else process.env.TMUX_TMPDIR = previousTmuxTmpDir
  if (previousTmuxIsolated === undefined) delete process.env.TMUXGO_TEST_TMUX_ISOLATED
  else process.env.TMUXGO_TEST_TMUX_ISOLATED = previousTmuxIsolated
  if (previousInvocationId === undefined) delete process.env.INVOCATION_ID
  else process.env.INVOCATION_ID = previousInvocationId
  // 隔离 server 退出是异步的，socket/lock 文件可能在删除遍历窗口内再现
  // （ENOTEMPTY）：fs.rm 原生按 maxRetries 重试，专门收口这类竞态
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  rmSync(tmuxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
// 中断路径（SIGINT 在 spawnSync 阻塞期间挂起、返回后即触发）：正常、失败、
// 中断都要清掉测试 server 与临时目录
process.once('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.once('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

let status = 0
try {
  if (parallelFiles.length) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...parallelFiles], {
      stdio: 'inherit',
      env: process.env,
    })
    status = result.status ?? 1
  }
  for (const file of serialFiles) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', file], {
      stdio: 'inherit',
      env: process.env,
    })
    if (status === 0) status = result.status ?? 1
  }
} finally {
  cleanup()
}
process.exit(status)
