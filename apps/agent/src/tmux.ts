import { exec } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const allowedSessions = new Set(
  (process.env.TMUX_WEB_ALLOWED_SESSIONS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
)

function isValidSessionName(name: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}
function normalizeTmuxEnvArgs(args: string[]) {
  const result: string[] = []
  let needsSetEnv = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && args[i + 1] === 'TMUXGO_ENV=1') {
      needsSetEnv = true
      i++
      continue
    }
    result.push(args[i])
  }
  return { args: result, needsSetEnv }
}
function isTmuxServerMissingError(message: string) {
  const value = message.toLowerCase()
  return (
    value.includes('error connecting to') ||
    value.includes('no server running') ||
    value.includes('failed to connect to server')
  )
}
function assertSessionAllowed(name: string) {
  if (!isValidSessionName(name)) throw new Error('Invalid session name')
  if (allowedSessions.size && !allowedSessions.has(name)) throw new Error('Session is not allowed')
}

export interface TmuxSession {
  id: string
  name: string
  windows: number
  created: string
  attached: boolean
}

export class TmuxManager {
  async enableMouse(name: string): Promise<void> {
    assertSessionAllowed(name)
    await execFileAsync('tmux', ['set-option', '-t', name, 'destroy-unattached', 'off'])
    await execFileAsync('tmux', ['set-option', '-t', name, '-g', 'mouse', 'on'])
  }
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await execAsync(
        'tmux list-sessions -F "#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"',
      )

      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((line) => {
          const [, name] = line.split('|')
          try {
            assertSessionAllowed(name)
            return true
          } catch {
            return false
          }
        })
        .map((line) => {
          const [id, name, windows, created, attached] = line.split('|')
          return {
            id,
            name,
            windows: parseInt(windows, 10),
            created: new Date(parseInt(created, 10) * 1000).toISOString(),
            attached: attached === '1',
          }
        })
    } catch (err: any) {
      if (err.message.includes('no server running')) {
        return []
      }
      throw err
    }
  }

  async createSession(name: string): Promise<TmuxSession> {
    assertSessionAllowed(name)
    try {
      await execFileAsync('tmux', ['setenv', '-g', 'TMUXGO_ENV', '1'])
    } catch (err: any) {
      if (!isTmuxServerMissingError(String(err?.message || ''))) throw err
    }
    if (process.env.INVOCATION_ID)
      await execFileAsync('systemd-run', [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        'tmux',
        'new-session',
        '-d',
        '-s',
        name,
      ])
    else await execFileAsync('tmux', ['new-session', '-d', '-s', name])
    try {
      await execFileAsync('tmux', ['setenv', '-g', 'TMUXGO_ENV', '1'])
    } catch {}
    await this.enableMouse(name)
    const sessions = await this.listSessions()
    const session = sessions.find((s) => s.name === name)
    if (!session) {
      throw new Error('Failed to create session')
    }
    return session
  }

  async killSession(name: string): Promise<void> {
    assertSessionAllowed(name)
    // '=' 前缀强制精确匹配：裸 -t 在目标不存在时按前缀/模式匹配，会误杀同名前缀的全部 session
    await execFileAsync('tmux', ['kill-session', '-t', `=${name}`])
  }

  async executeTmux(args: string[]) {
    if (
      !Array.isArray(args) ||
      !args.length ||
      args.length > 64 ||
      args.some((item) => typeof item !== 'string' || item.length > 4096)
    )
      throw new Error('Invalid tmux arguments')
    const normalized = normalizeTmuxEnvArgs(args)
    if (normalized.needsSetEnv) {
      try {
        await execFileAsync('tmux', ['setenv', '-g', 'TMUXGO_ENV', '1'])
      } catch (err: any) {
        if (!isTmuxServerMissingError(String(err?.message || ''))) throw err
      }
    }
    const { stdout, stderr } = await execFileAsync('tmux', normalized.args)
    if (normalized.needsSetEnv) {
      try {
        await execFileAsync('tmux', ['setenv', '-g', 'TMUXGO_ENV', '1'])
      } catch {}
    }
    return { stdout, stderr }
  }
  attach(name: string, cols: number, rows: number, exclusive: boolean) {
    assertSessionAllowed(name)
    const args = ['attach']
    if (!exclusive) args.push('-f', 'ignore-size,active-pane')
    args.push('-t', name)
    return pty.spawn('tmux', args, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  }
}
