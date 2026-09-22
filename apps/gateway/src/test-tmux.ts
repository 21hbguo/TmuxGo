// 真实 tmux 行为测试的共享约定（import 本模块即视为真实 tmux 用例）：
// 一律操作隔离 server 上名为 test 的 session（AGENTS.md 约束，不得动用户
// 其他 session）。run-tests.ts 以独立 TMUX_TMPDIR 起专用 server，并把引用
// 本模块的文件排进串行组——共享同一 session，跨文件并发会互踩 window/pane
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const TEST_TMUX_SESSION = 'test'
export const execTmuxFile = promisify(execFile)
// 用例收尾只删 test session（最后一个 session 消失时隔离 server 自然退出），
// 绝不在默认 socket 上 kill-server——那是用户日常 server
export const killTestTmuxSession = () => execTmuxFile('tmux', ['kill-session', '-t', TEST_TMUX_SESSION]).catch(() => {})
