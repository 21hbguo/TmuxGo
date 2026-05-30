import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getTemplateWindowTargets, type SessionTemplateLayout } from '../lib/template-utils.js'
import { assertSessionAllowed, isValidSessionName, prepareSessionAttach } from '../lib/tmux-policy.js'

const execFileAsync = promisify(execFile)

async function getLocalTmuxSessions() {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'])

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
async function getFirstWindowTarget(sessionName: string) {
  const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}', '-f', '#{==:#{window_active},1}'])
  const activeIndex = stdout.trim()
  if (activeIndex) return `${sessionName}:${activeIndex}`
  const { stdout: fallbackStdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const fallbackIndex = fallbackStdout.trim().split('\n').find(Boolean)
  if (!fallbackIndex) throw new Error(`No windows found for session ${sessionName}`)
  return `${sessionName}:${fallbackIndex}`
}
async function getFirstWindowIndex(sessionName: string) {
  const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No windows found for session ${sessionName}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid window index for session ${sessionName}`)
  return value
}
async function getFirstPaneIndex(windowTarget: string) {
  const { stdout } = await execFileAsync('tmux', ['list-panes', '-t', windowTarget, '-F', '#{pane_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No panes found for window ${windowTarget}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid pane index for window ${windowTarget}`)
  return value
}
async function applyTemplateLayout(sessionName: string, layout: SessionTemplateLayout) {
  assertSessionAllowed(sessionName)
  if (!layout.windows.length) return
  const firstWindowTarget = await getFirstWindowTarget(sessionName)
  const firstWindowIndex = await getFirstWindowIndex(sessionName)
  const targets = getTemplateWindowTargets(sessionName, layout, firstWindowIndex)
  for (let i = 0; i < targets.length; i++) {
    const windowDef = targets[i]
    if (!windowDef.name) throw new Error(`Template step failed: window[${i}] missing name`)
    if (i === 0) {
      await execFileAsync('tmux', ['rename-window', '-t', firstWindowTarget, windowDef.name])
    } else {
      await execFileAsync('tmux', ['new-window', '-t', sessionName, '-n', windowDef.name])
    }
    const { windowTarget, panes } = windowDef
    const paneBaseIndex = i === 0 ? await getFirstPaneIndex(firstWindowTarget) : await getFirstPaneIndex(windowTarget)
    for (let p = 1; p < panes.length; p++) {
      await execFileAsync('tmux', ['split-window', '-t', windowTarget, '-h'])
    }
    await execFileAsync('tmux', ['select-layout', '-t', windowTarget, 'tiled'])
    for (let p = 0; p < panes.length; p++) {
      const command = panes[p]?.command?.trim()
      if (!command) continue
      await runSendKeys(`${windowTarget}.${paneBaseIndex + p}`, command)
    }
  }
  await execFileAsync('tmux', ['select-window', '-t', firstWindowTarget])
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
        await prepareSessionAttach(existingSession.name)
        return existingSession
      }
      assertSessionAllowed(name)
      await execFileAsync('tmux', ['new-session', '-d', '-s', name])
      if (layout?.windows?.length) {
        try {
          await applyTemplateLayout(name, layout)
        } catch (err: any) {
          await cleanupSession(name)
          throw new Error(err?.message || 'Template layout failed')
        }
      }
      await prepareSessionAttach(name)
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
  fastify.post('/hosts/:hostId/sessions/rename', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { sessionId, name } = request.body as { sessionId: string; name: string }
    const sessionName = sessionId.replace('session-', '')
    if (!isValidSessionName(sessionName) || !isValidSessionName(name)) throw new Error('Invalid session name')
    assertSessionAllowed(sessionName)
    assertSessionAllowed(name)
    try {
      await execFileAsync('tmux', ['rename-session', '-t', sessionName, name])
      await prepareSessionAttach(name)
      const sessions = await getLocalTmuxSessions()
      return sessions.find((session) => session.name === name) || {
        id: `session-${name}`,
        hostId,
        name,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        windowCount: 1,
      }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })

  fastify.delete('/hosts/:hostId/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = sessionId.replace('session-', '')
    if (!isValidSessionName(sessionName)) {
      throw new Error('Invalid session name')
    }
    assertSessionAllowed(sessionName)

    try {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName])
      return { success: true, sessionId }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
