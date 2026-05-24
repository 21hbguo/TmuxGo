import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

async function enableMouse(sessionName: string) {
  await execAsync(`tmux set-option -t ${sessionName} -g mouse on`)
}

async function getLocalTmuxSessions() {
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
          id: `session-${name}`,
          hostId: 'local',
          name,
          createdAt: new Date(parseInt(created, 10) * 1000).toISOString(),
          lastActiveAt: new Date().toISOString(),
          windowCount: parseInt(windows, 10),
        }
      })
  } catch (err: any) {
    console.error('Failed to list tmux sessions:', err)
    return []
  }
}

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions', async (request) => {
    return getLocalTmuxSessions()
  })

  fastify.post('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { name } = request.body as { name: string }

    try {
      const existingSessions = await getLocalTmuxSessions()
      const existingSession = existingSessions.find((s) => s.name === name)
      if (existingSession) {
        await enableMouse(existingSession.name)
        return existingSession
      }
      await execAsync(`tmux new-session -d -s ${name}`)
      await enableMouse(name)
      const sessions = await getLocalTmuxSessions()
      return sessions.find((s) => s.name === name) || {
        id: `session-${name}`,
        hostId,
        name,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        windowCount: 1,
      }
    } catch (err: any) {
      if (String(err?.message || '').includes('duplicate session')) {
        const sessions = await getLocalTmuxSessions()
        const existingSession = sessions.find((s) => s.name === name)
        if (existingSession) {
          return existingSession
        }
      }
      throw new Error(err.message)
    }
  })

  fastify.delete('/hosts/:hostId/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = sessionId.replace('session-', '')

    try {
      await execAsync(`tmux kill-session -t ${sessionName}`)
      return { success: true, sessionId }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
