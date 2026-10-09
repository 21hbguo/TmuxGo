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
