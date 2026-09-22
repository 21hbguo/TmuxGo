import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

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
const files = collectTests(join(root, 'tests'))
if (files.length === 0) {
  console.error('No test files found')
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
console.log(`collected ${files.length} test files (${serialFiles.length} serial tmux)`)

// Isolate unit-test side effects away from the real ~/.tmuxgo config dir.
const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
const previousTmpDir = process.env.TMUXGO_TMP_DIR
const previousTmux = process.env.TMUX
const previousTmuxTmpDir = process.env.TMUX_TMPDIR
const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-unit-tests-'))
// 测试专用 tmux server：独立 socket 目录，清空 TMUX 避免继承外层 pane 的
// socket 路径（run-e2e.ts 同款做法）。直接命令与应用子进程走同一 server
const tmuxDir = mkdtempSync(join(tmpdir(), 'tmuxgo-test-tmux-'))
process.env.TMUXGO_CONFIG_DIR = configDir
process.env.TMUXGO_PREFERENCES_DIR = join(configDir, 'preferences')
process.env.TMUXGO_TMP_DIR = join(configDir, 'tmp')
process.env.TMUX = ''
process.env.TMUX_TMPDIR = tmuxDir

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  // 只 kill 测试专用 server（独立 socket 目录内）；禁止默认 socket kill-server
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir } })
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
  rmSync(configDir, { recursive: true, force: true })
  rmSync(tmuxDir, { recursive: true, force: true })
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
