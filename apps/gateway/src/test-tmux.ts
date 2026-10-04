// 真实 tmux 行为测试的共享约定（import 本模块即视为真实 tmux 用例）：
// 一律操作隔离 server 上名为 test 的 session（AGENTS.md 约束，不得动用户
// 其他 session）。run-tests.ts 以独立 TMUX_TMPDIR 起专用 server，并把引用
// 本模块的文件排进串行组——共享同一 session，跨文件并发会互踩 window/pane
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

// 硬约束：必须经由根目录 pnpm test（run-tests.ts）跑——它设独立 TMUX_TMPDIR
// 并置 TMUXGO_TEST_TMUX_ISOLATED 标记。直接 tsx --test / vitest 本文件会
// 落到用户日常 tmux server，曾因此误杀会话
if (!process.env.TMUXGO_TEST_TMUX_ISOLATED) {
  throw new Error(
    'Real-tmux tests must run via root `pnpm test` (scripts/run-tests.ts sets an isolated TMUX_TMPDIR). Refusing to touch the user tmux server.',
  )
}

export const TEST_TMUX_SESSION = 'test'
const execFileAsync = promisify(execFile)
function isolatedTmuxArgs(args: string[]) {
  const tmuxDir = process.env.TMUX_TMPDIR
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  if (!tmuxDir) throw new Error('TMUX_TMPDIR is required for isolated tmux tests')
  return ['-S', join(tmuxDir, `tmux-${uid}`, 'default'), ...args]
}
// 统一显式 socket；即便调用方错误继承 TMUX，也不能把测试命令路由到用户 server。
export const execTmuxFile = (file: string, args: string[]) =>
  execFileAsync(file, file === 'tmux' ? isolatedTmuxArgs(args) : args)

// tmux may accept new-session before the detached pane is ready to process keys.
// Retry only the transient startup error; other failures stay fatal.
export async function sendTmuxKeys(target: string, ...keys: string[]) {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await execTmuxFile('tmux', ['send-keys', '-t', target, ...keys])
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('not in a mode') || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}
// 用例收尾只删 test session（最后一个 session 消失时隔离 server 自然退出），
// 绝不在默认 socket 上 kill-server——那是用户日常 server
export const killTestTmuxSession = () => execTmuxFile('tmux', ['kill-session', '-t', TEST_TMUX_SESSION]).catch(() => {})
