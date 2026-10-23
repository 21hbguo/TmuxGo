import { execFile } from 'child_process'
import { promisify } from 'util'
import { execTmux } from './tmux-executor.js'

const execFileAsync = promisify(execFile)
const allowedSessions = new Set(
  (process.env.TMUX_WEB_ALLOWED_SESSIONS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
)

export function isValidSessionName(name: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}
export function assertSessionAllowed(sessionName: string) {
  if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
  if (allowedSessions.size && !allowedSessions.has(sessionName)) throw new Error('Session is not allowed')
}
export async function assertTargetAllowed(target: string, expectedSessionName?: string) {
  const sessionName = await getTargetSessionName(target)
  assertSessionAllowed(sessionName)
  if (expectedSessionName && sessionName !== expectedSessionName)
    throw new Error('Tmux target does not belong to session')
  return sessionName
}
// 我们创建的 session 显式钉住回看深度。history-limit 是 session option，tmux 默认只有
// 2000 行，而宿主的 ~/.tmux.conf 可能设成任意值（实测见过 50000）——同一份「跨 pane 搜索 /
// 会话快照」在不同主机上能搜到多深就变成了看运气。
// 20000 行按 80 列估约 1.6MB/pane 上限，8 pane 会话仍在可控范围。
export const TMUXGO_HISTORY_LIMIT = 20000
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
}
let prepareSessionAttachImpl: PrepareSessionAttach = defaultPrepareSessionAttach
// 测试缝：单测 attach 路径不触真实 tmux set-option
export function setPrepareSessionAttachForTest(fn: PrepareSessionAttach | null) {
  prepareSessionAttachImpl = fn ?? defaultPrepareSessionAttach
}
export async function prepareSessionAttach(hostId: string, sessionName: string) {
  await prepareSessionAttachImpl(hostId, sessionName)
}
async function getTargetSessionName(target: string) {
  if (!target) throw new Error('Missing tmux target')
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{session_name}'])
  const sessionName = stdout.trim()
  if (!sessionName) throw new Error('Unable to resolve session')
  return sessionName
}
