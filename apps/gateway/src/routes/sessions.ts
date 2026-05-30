import type { FastifyInstance } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getTemplateWindowTargets, type SessionTemplateLayout } from '../lib/template-utils.js'
import { assertSessionAllowed, isValidSessionName, prepareSessionAttach } from '../lib/tmux-policy.js'

const execFileAsync = promisify(execFile)
const batchDeleteLimitDefault = 1000
const batchDeleteLimitMax = 5000

type BatchDeleteMode = 'preview' | 'execute'
interface LocalTmuxSession {
  id: string
  hostId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
  attached: boolean
}
interface BatchDeleteFilters {
  createdBefore?: string
  inactiveBefore?: string
  nameIncludes?: string
  includeAttached?: boolean
}
interface BatchDeleteRequest {
  mode?: BatchDeleteMode
  sessionIds?: string[]
  filters?: BatchDeleteFilters
  limit?: number
  force?: boolean
}
interface BatchDeleteSkip {
  sessionId: string
  name: string
  reason: string
}
interface BatchDeleteTarget {
  sessionId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
  attached: boolean
}

function normalizeSessionName(sessionRef: string) {
  const sessionName = sessionRef.startsWith('session-') ? sessionRef.slice('session-'.length) : sessionRef
  if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
  return sessionName
}
function parseOptionalDate(value: string | undefined, fieldName: string) {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${fieldName}`)
  return timestamp
}
function normalizeBatchLimit(limit: number | undefined) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return batchDeleteLimitDefault
  return Math.max(1, Math.min(batchDeleteLimitMax, Math.floor(limit)))
}
function hasBatchDeleteFilter(filters: BatchDeleteFilters | undefined) {
  if (!filters) return false
  if (filters.createdBefore) return true
  if (filters.inactiveBefore) return true
  if (typeof filters.nameIncludes === 'string' && filters.nameIncludes.trim()) return true
  if (filters.includeAttached === true) return true
  return false
}
function toBatchDeleteTarget(session: LocalTmuxSession): BatchDeleteTarget {
  return {
    sessionId: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    windowCount: session.windowCount,
    attached: session.attached,
  }
}
async function getLocalTmuxSessions(): Promise<LocalTmuxSession[]> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_activity}|#{session_attached}'])
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
        const [id, name, windows, created, activity, attached] = line.split('|')
        const createdAtUnix = parseInt(created, 10)
        const activityUnix = parseInt(activity, 10)
        const attachedCount = parseInt(attached, 10)
        const createdAt = Number.isFinite(createdAtUnix) ? new Date(createdAtUnix * 1000).toISOString() : new Date().toISOString()
        const lastActiveAt = Number.isFinite(activityUnix) ? new Date(activityUnix * 1000).toISOString() : createdAt
        return {
          id: `session-${name}`,
          hostId: 'local',
          name,
          createdAt,
          lastActiveAt,
          windowCount: parseInt(windows, 10),
          attached: Number.isFinite(attachedCount) && attachedCount > 0,
        }
      })
  } catch (err: any) {
    console.error('Failed to list tmux sessions:', err)
    return []
  }
}
function getBatchDeleteSelection(sessions: LocalTmuxSession[], body: BatchDeleteRequest) {
  const filters = body.filters
  const includeAttached = filters?.includeAttached === true
  const createdBeforeTs = parseOptionalDate(filters?.createdBefore, 'filters.createdBefore')
  const inactiveBeforeTs = parseOptionalDate(filters?.inactiveBefore, 'filters.inactiveBefore')
  const nameIncludes = typeof filters?.nameIncludes === 'string' ? filters.nameIncludes.trim().toLowerCase() : ''
  const selectedSessionNames = new Set<string>()
  if (Array.isArray(body.sessionIds)) {
    for (const sessionId of body.sessionIds) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) continue
      selectedSessionNames.add(normalizeSessionName(sessionId.trim()))
    }
  }
  if (!selectedSessionNames.size && !hasBatchDeleteFilter(filters)) throw new Error('sessionIds or filters is required')
  let matched = sessions
  if (selectedSessionNames.size) matched = matched.filter((session) => selectedSessionNames.has(session.name))
  if (nameIncludes) matched = matched.filter((session) => session.name.toLowerCase().includes(nameIncludes))
  if (createdBeforeTs !== null) matched = matched.filter((session) => Date.parse(session.createdAt) < createdBeforeTs)
  if (inactiveBeforeTs !== null) matched = matched.filter((session) => Date.parse(session.lastActiveAt) < inactiveBeforeTs)
  const skipped: BatchDeleteSkip[] = []
  if (selectedSessionNames.size) {
    const existingNames = new Set(sessions.map((session) => session.name))
    for (const sessionName of selectedSessionNames) {
      if (!existingNames.has(sessionName)) skipped.push({ sessionId: `session-${sessionName}`, name: sessionName, reason: 'not_found' })
    }
  }
  const eligible: LocalTmuxSession[] = []
  for (const session of matched) {
    if (session.attached && !includeAttached) {
      skipped.push({ sessionId: session.id, name: session.name, reason: 'attached' })
      continue
    }
    eligible.push(session)
  }
  return { matched, eligible, skipped }
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
        attached: false,
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
    const sessionName = normalizeSessionName(sessionId)
    if (!isValidSessionName(name)) throw new Error('Invalid session name')
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
        attached: false,
      }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
  fastify.post('/hosts/:hostId/sessions/batch-delete', async (request) => {
    const body = (request.body || {}) as BatchDeleteRequest
    const mode: BatchDeleteMode = body.mode === 'execute' ? 'execute' : 'preview'
    const limit = normalizeBatchLimit(body.limit)
    const sessions = await getLocalTmuxSessions()
    const { matched, eligible, skipped } = getBatchDeleteSelection(sessions, body)
    const forceRequired = eligible.length > limit
    const limited = eligible.slice(0, limit)
    if (mode === 'preview') {
      return {
        mode,
        limit,
        forceRequired,
        matchedCount: matched.length,
        deletableCount: eligible.length,
        deleteCount: limited.length,
        skipped,
        sessions: limited.map(toBatchDeleteTarget),
      }
    }
    if (forceRequired && body.force !== true) {
      throw new Error(`Delete candidate count ${eligible.length} exceeds limit ${limit}, set force=true to continue`)
    }
    const targets = forceRequired && body.force === true ? eligible : limited
    const deleted: BatchDeleteTarget[] = []
    const failed: BatchDeleteSkip[] = []
    for (const session of targets) {
      try {
        await execFileAsync('tmux', ['kill-session', '-t', session.name])
        deleted.push(toBatchDeleteTarget(session))
      } catch (err: any) {
        failed.push({ sessionId: session.id, name: session.name, reason: err?.message || 'delete_failed' })
      }
    }
    return {
      mode,
      limit,
      forceUsed: body.force === true,
      forceRequired,
      matchedCount: matched.length,
      deletableCount: eligible.length,
      attemptedCount: targets.length,
      deletedCount: deleted.length,
      failedCount: failed.length,
      skipped,
      deleted,
      failed,
    }
  })

  fastify.delete('/hosts/:hostId/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = normalizeSessionName(sessionId)
    assertSessionAllowed(sessionName)

    try {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName])
      return { success: true, sessionId: `session-${sessionName}` }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
