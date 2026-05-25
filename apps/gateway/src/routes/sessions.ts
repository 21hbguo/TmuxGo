import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getTemplateWindowTargets, type SessionTemplateLayout } from '../lib/template-utils.js'

const execFileAsync = promisify(execFile)
function isValidSessionName(name: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name)
}

async function enableMouse(sessionName: string) {
  await execFileAsync('tmux', ['set-option', '-t', sessionName, '-g', 'mouse', 'on'])
}

async function getLocalTmuxSessions() {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'])

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
async function runSendKeys(target: string, command: string) {
  await execFileAsync('tmux', ['send-keys', '-t', target, command, 'C-m'])
}
async function applyTemplateLayout(sessionName: string, layout: SessionTemplateLayout) {
  if (!layout.windows.length) return
  const targets = getTemplateWindowTargets(sessionName, layout)
  for (let i = 0; i < targets.length; i++) {
    const windowDef = targets[i]
    if (!windowDef.name) throw new Error(`Template step failed: window[${i}] missing name`)
    if (i === 0) {
      await execFileAsync('tmux', ['rename-window', '-t', `${sessionName}:0`, windowDef.name])
    } else {
      await execFileAsync('tmux', ['new-window', '-t', sessionName, '-n', windowDef.name])
    }
    const { windowTarget, panes } = windowDef
    for (let p = 1; p < panes.length; p++) {
      await execFileAsync('tmux', ['split-window', '-t', windowTarget, '-h'])
    }
    await execFileAsync('tmux', ['select-layout', '-t', windowTarget, 'tiled'])
    for (let p = 0; p < panes.length; p++) {
      const command = panes[p]?.command?.trim()
      if (!command) continue
      await runSendKeys(`${windowTarget}.${p}`, command)
    }
  }
  await execFileAsync('tmux', ['select-window', '-t', `${sessionName}:0`])
}
async function cleanupSession(sessionName: string) {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', sessionName])
  } catch {}
}

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions', async (request) => {
    return getLocalTmuxSessions()
  })

  fastify.post('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { name, layout } = request.body as { name: string; layout?: SessionTemplateLayout }
    if (!isValidSessionName(name)) {
      throw new Error('Invalid session name')
    }

    try {
      const existingSessions = await getLocalTmuxSessions()
      const existingSession = existingSessions.find((s) => s.name === name)
      if (existingSession) {
        await enableMouse(existingSession.name)
        return existingSession
      }
      await execFileAsync('tmux', ['new-session', '-d', '-s', name])
      if (layout?.windows?.length) {
        try {
          await applyTemplateLayout(name, layout)
        } catch (err: any) {
          await cleanupSession(name)
          throw new Error(err?.message || 'Template layout failed')
        }
      }
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
    if (!isValidSessionName(sessionName)) {
      throw new Error('Invalid session name')
    }

    try {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName])
      return { success: true, sessionId }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
