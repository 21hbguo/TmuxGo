import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface TmuxSession {
  id: string
  name: string
  windows: number
  created: string
  attached: boolean
}

export class TmuxManager {
  async enableMouse(name: string): Promise<void> {
    await execAsync(`tmux set-option -t ${name} -g mouse on`)
  }
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await execAsync(
        'tmux list-sessions -F "#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"'
      )

      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
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
    await execAsync(`tmux new-session -d -s ${name}`)
    await this.enableMouse(name)
    const sessions = await this.listSessions()
    const session = sessions.find((s) => s.name === name)
    if (!session) {
      throw new Error('Failed to create session')
    }
    return session
  }

  async killSession(name: string): Promise<void> {
    await execAsync(`tmux kill-session -t ${name}`)
  }

  async execute(command: string): Promise<string> {
    const { stdout, stderr } = await execAsync(command)
    if (stderr) {
      console.error('Command stderr:', stderr)
    }
    return stdout
  }
}
