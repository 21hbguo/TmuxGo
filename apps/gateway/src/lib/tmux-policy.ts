import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const allowedSessions = new Set((process.env.TMUX_WEB_ALLOWED_SESSIONS || '').split(',').map((name) => name.trim()).filter(Boolean))

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
  if (expectedSessionName && sessionName !== expectedSessionName) throw new Error('Tmux target does not belong to session')
  return sessionName
}
export async function prepareSessionAttach(sessionName: string) {
  assertSessionAllowed(sessionName)
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'destroy-unattached', 'off'])
  await execFileAsync('tmux', ['set-option', '-t', sessionName, '-g', 'mouse', 'on'])
}
async function getTargetSessionName(target: string) {
  if (!target) throw new Error('Missing tmux target')
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{session_name}'])
  const sessionName = stdout.trim()
  if (!sessionName) throw new Error('Unable to resolve session')
  return sessionName
}
