import { TMUX_HISTORY_LIMIT_LINES } from './scrollback-budget.js'
import { execTmux } from './tmux-executor.js'

const allowedSessions = new Set(
  (process.env.TMUX_WEB_ALLOWED_SESSIONS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
)

export function isValidSessionName(name: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}
// 布尔版本给「列表投影」用（fleet.list 按 session 过滤，不能靠抛异常逐行试）
export function isSessionAllowed(sessionName: string) {
  if (!isValidSessionName(sessionName)) return false
  return !allowedSessions.size || allowedSessions.has(sessionName)
}
export function assertSessionAllowed(sessionName: string) {
  if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
  if (allowedSessions.size && !allowedSessions.has(sessionName)) throw new Error('Session is not allowed')
}
export async function assertTargetAllowed(hostId: string, target: string, expectedSessionName?: string) {
  const sessionName = await getTargetSessionName(hostId, target)
  assertSessionAllowed(sessionName)
  if (expectedSessionName && sessionName !== expectedSessionName)
    throw new Error('Tmux target does not belong to session')
  return sessionName
}
// 我们创建的 session 显式钉住回看深度。history-limit 是 session option，tmux 默认只有
// 2000 行，而宿主的 ~/.tmux.conf 可能设成任意值（实测见过 50000）——同一份「跨 pane 搜索 /
// 会话快照」在不同主机上能搜到多深就变成了看运气。数字与换算见 scrollback-budget.ts
// （全仓回看口径的唯一真值源，改值只改那里）。
export const TMUXGO_HISTORY_LIMIT = TMUX_HISTORY_LIMIT_LINES
const parseHistoryLimit = (stdout: string) => {
  const value = Number(stdout.trim().split(/\s+/)[1] || 0)
  return Number.isFinite(value) ? value : 0
}
// pane 的 history-limit 在 pane **创建那一刻**就从当时的选项拷进 pane 结构，之后再改
// session 选项或 respawn 都不会重读（实测 tmux 3.4）。所以：
//   1) 建 session 之前先把全局值升到策略下限——首个 pane 才拿得到 20000；
//   2) 只升不降：宿主配置更高（如 50000）时保留用户选择，不悄悄缩小别人的回看缓冲。
export async function raiseServerHistoryLimit(hostId: string) {
  const { stdout } = await execTmux(hostId, ['show-options', '-g', 'history-limit'])
  if (parseHistoryLimit(stdout) >= TMUXGO_HISTORY_LIMIT) return false
  await execTmux(hostId, ['set-option', '-g', 'history-limit', String(TMUXGO_HISTORY_LIMIT)])
  return true
}
// 建 session 之后再钉一次 session 级值：之后 split/new-window/模板布局新建的 pane 都按
// 策略值来，不受全局值后续变动影响（用户若手动改全局，我们创建的会话仍然稳定）
export async function applyCreatedSessionDefaults(hostId: string, sessionName: string) {
  assertSessionAllowed(sessionName)
  await execTmux(hostId, ['set-option', '-t', sessionName, 'history-limit', String(TMUXGO_HISTORY_LIMIT)])
}
type PrepareSessionAttach = (hostId: string, sessionName: string) => Promise<void>
// set-option 经 execTmux 路由而非本机 execFile：local 直跑 tmux，远端复用 agent/ssh 通道，
// 所有 host 的 session 在 attach 前都拿到 destroy-unattached off + mouse on
async function defaultPrepareSessionAttach(hostId: string, sessionName: string) {
  assertSessionAllowed(sessionName)
  await execTmux(hostId, ['set-option', '-t', sessionName, 'destroy-unattached', 'off'])
  await execTmux(hostId, ['set-option', '-t', sessionName, '-g', 'mouse', 'on'])
  await ensureGlobalRemainOnExit(hostId)
}
let prepareSessionAttachImpl: PrepareSessionAttach = defaultPrepareSessionAttach
// 测试缝：单测 attach 路径不触真实 tmux set-option
export function setPrepareSessionAttachForTest(fn: PrepareSessionAttach | null) {
  prepareSessionAttachImpl = fn ?? defaultPrepareSessionAttach
}
export async function prepareSessionAttach(hostId: string, sessionName: string) {
  await prepareSessionAttachImpl(hostId, sessionName)
}
type TmuxExecRunner = typeof execTmux
let execTmuxImpl: TmuxExecRunner = execTmux
// 测试缝：策略断言的用例不该触真实 tmux/ssh（与本文件 setPrepareSessionAttachForTest 同款）
export function setExecTmuxForTest(fn: TmuxExecRunner | null) {
  execTmuxImpl = fn ?? execTmux
}
// remain-on-exit failed（'failed' 值是 tmux 3.4 新增）：pane 根进程被信号/非零退出
// 杀掉时留下死 pane（tmux 渲染 "Pane is dead" 框）而不是整窗静默消失——裸命令 pane
// （new-session/new-window 直带 shell-command）按 Ctrl+C 正是这种死法，曾吃掉用户
// 正在跑代码的 train session；干净退出 exit 0 照常关窗不留僵尸。
// 只钉 -g 全局：window 选项对「后建 window」的查找走 window 自身表→全局，-t <session>
// 层实测（tmux 3.4）不覆盖新 window；全局一次设置对已存在/未来 window 同时兜底。
// 按 host 缓存探测结果：老 tmux 不认 'failed'，失败一次即跳过，不随每次 attach 重放。
const remainOnExitFailed = new Map<string, boolean>()
export async function ensureGlobalRemainOnExit(hostId: string) {
  if (remainOnExitFailed.has(hostId)) return
  try {
    await execTmuxImpl(hostId, ['set-window-option', '-g', 'remain-on-exit', 'failed'])
    remainOnExitFailed.set(hostId, true)
  } catch {
    remainOnExitFailed.set(hostId, false)
  }
}
export function _resetRemainOnExitForTest() {
  remainOnExitFailed.clear()
}
// 经 execTmux 路由：local 直跑本机 tmux，远端走 agent/ssh 通道。策略断言因此对远端
// 也成立——早先用本机 execFile 解析 pane→session，远端拿不到结果，只能整段放行。
// 代价是每次断言多一条 display-message；被断言的动作本身就要发 execTmux，可接受。
async function getTargetSessionName(hostId: string, target: string) {
  if (!target) throw new Error('Missing tmux target')
  const { stdout } = await execTmuxImpl(hostId, ['display-message', '-p', '-t', target, '#{session_name}'])
  const sessionName = stdout.trim()
  if (!sessionName) throw new Error('Unable to resolve session')
  return sessionName
}
