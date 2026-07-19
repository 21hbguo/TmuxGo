import type { FastifyInstance } from 'fastify'
import { getTemplateWindowTargets, type SessionTemplateLayout } from '../lib/template-utils.js'
import { assertSessionAllowed, isValidSessionName, prepareSessionAttach } from '../lib/tmux-policy.js'
import { buildSessionId, parseSessionRef } from '../lib/tmux-target.js'
import { execTmux } from '../lib/tmux-executor.js'

const batchDeleteLimitDefault = 1000
const batchDeleteLimitMax = 5000
type BatchDeleteMode = 'preview' | 'execute'
interface HostTmuxSession {
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
interface SessionThumbnailPane {
  id: string
  title: string
  active: boolean
  left: number
  top: number
  size: { cols: number; rows: number }
  data: string
}
interface SessionThumbnail {
  id: string
  name: string
  window: { id: string; index: number; name: string; zoomed: boolean } | null
  panes: SessionThumbnailPane[]
}
function normalizeSessionName(hostId: string, sessionRef: string) {
  return parseSessionRef(hostId, sessionRef).sessionName
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
function toBatchDeleteTarget(session: HostTmuxSession): BatchDeleteTarget {
  return {
    sessionId: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    windowCount: session.windowCount,
    attached: session.attached,
  }
}
async function getHostTmuxSessions(hostId: string): Promise<HostTmuxSession[]> {
  try {
    const { stdout } = await execTmux(hostId, ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_activity}|#{session_attached}'])
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
        const [, name, windows, created, activity, attached] = line.split('|')
        const createdAtUnix = parseInt(created, 10)
        const activityUnix = parseInt(activity, 10)
        const attachedCount = parseInt(attached, 10)
        const createdAt = Number.isFinite(createdAtUnix) ? new Date(createdAtUnix * 1000).toISOString() : new Date().toISOString()
        const lastActiveAt = Number.isFinite(activityUnix) ? new Date(activityUnix * 1000).toISOString() : createdAt
        return {
          id: buildSessionId(hostId, name),
          hostId,
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
async function getSessionThumbnails(hostId: string): Promise<SessionThumbnail[]> {
  const sessions = await getHostTmuxSessions(hostId)
  if (!sessions.length) return []
  const sessionByName = new Map(sessions.map((session) => [session.name, session]))
  const { stdout } = await execTmux(hostId, ['list-panes', '-a', '-F', '#{session_name}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}|#{pane_id}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}'])
  const thumbnails = new Map<string, SessionThumbnail>()
  for (const session of sessions) thumbnails.set(session.name, { id: session.id, name: session.name, window: null, panes: [] })
  const captures: { pane: SessionThumbnailPane; target: string }[] = []
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [sessionName, windowId, windowIndex, windowName, windowActive, windowZoomed, paneId, title, paneActive, width, height, left, top] = line.split('|')
    if (windowActive !== '1' || !sessionByName.has(sessionName)) continue
    const thumbnail = thumbnails.get(sessionName)
    if (!thumbnail) continue
    if (!thumbnail.window) thumbnail.window = { id: `${hostId}:${windowId}`, index: parseInt(windowIndex, 10) || 0, name: windowName, zoomed: windowZoomed === '1' }
    const pane = {
      id: `${hostId}:${paneId}`,
      title: title || 'shell',
      active: paneActive === '1',
      left: parseInt(left, 10) || 0,
      top: parseInt(top, 10) || 0,
      size: { cols: parseInt(width, 10) || 80, rows: parseInt(height, 10) || 24 },
      data: '',
    }
    thumbnail.panes.push(pane)
    captures.push({ pane, target: paneId })
  }
  await Promise.all(captures.map(async ({ pane, target }) => {
    try {
      const { stdout: data } = await execTmux(hostId, ['capture-pane', '-pt', target, '-p'])
      pane.data = data
    } catch {}
  }))
  return sessions.map((session) => thumbnails.get(session.name)!).filter((thumbnail) => !!thumbnail.window)
}
function getBatchDeleteSelection(hostId: string, sessions: HostTmuxSession[], body: BatchDeleteRequest) {
  const filters = body.filters
  const includeAttached = filters?.includeAttached === true
  const createdBeforeTs = parseOptionalDate(filters?.createdBefore, 'filters.createdBefore')
  const inactiveBeforeTs = parseOptionalDate(filters?.inactiveBefore, 'filters.inactiveBefore')
  const nameIncludes = typeof filters?.nameIncludes === 'string' ? filters.nameIncludes.trim().toLowerCase() : ''
  const selectedSessionNames = new Set<string>()
  if (Array.isArray(body.sessionIds)) {
    for (const sessionId of body.sessionIds) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) continue
      selectedSessionNames.add(normalizeSessionName(hostId, sessionId.trim()))
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
      if (!existingNames.has(sessionName)) skipped.push({ sessionId: buildSessionId(hostId, sessionName), name: sessionName, reason: 'not_found' })
    }
  }
  const eligible: HostTmuxSession[] = []
  for (const session of matched) {
    if (session.attached && !includeAttached) {
      skipped.push({ sessionId: session.id, name: session.name, reason: 'attached' })
      continue
    }
    eligible.push(session)
  }
  return { matched, eligible, skipped }
}
async function runSendKeys(hostId: string, target: string, command: string) {
  await execTmux(hostId, ['send-keys', '-t', target, command, 'C-m'])
}
async function getFirstWindowTarget(hostId: string, sessionName: string) {
  const { stdout } = await execTmux(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_index}', '-f', '#{==:#{window_active},1}'])
  const activeIndex = stdout.trim()
  if (activeIndex) return `${sessionName}:${activeIndex}`
  const { stdout: fallbackStdout } = await execTmux(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const fallbackIndex = fallbackStdout.trim().split('\n').find(Boolean)
  if (!fallbackIndex) throw new Error(`No windows found for session ${sessionName}`)
  return `${sessionName}:${fallbackIndex}`
}
async function getFirstWindowIndex(hostId: string, sessionName: string) {
  const { stdout } = await execTmux(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No windows found for session ${sessionName}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid window index for session ${sessionName}`)
  return value
}
async function getFirstPaneIndex(hostId: string, windowTarget: string) {
  const { stdout } = await execTmux(hostId, ['list-panes', '-t', windowTarget, '-F', '#{pane_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No panes found for window ${windowTarget}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid pane index for window ${windowTarget}`)
  return value
}
async function applyTemplateLayout(hostId: string, sessionName: string, layout: SessionTemplateLayout) {
  assertSessionAllowed(sessionName)
  if (!layout.windows.length) return
  const firstWindowTarget = await getFirstWindowTarget(hostId, sessionName)
  const firstWindowIndex = await getFirstWindowIndex(hostId, sessionName)
  const targets = getTemplateWindowTargets(sessionName, layout, firstWindowIndex)
  for (let i = 0; i < targets.length; i++) {
    const windowDef = targets[i]
    if (!windowDef.name) throw new Error(`Template step failed: window[${i}] missing name`)
    const splitFlag = windowDef.splitDirection === 'vertical' ? '-v' : '-h'
    const layoutPreset = windowDef.layoutPreset || 'tiled'
    if (i === 0) {
      await execTmux(hostId, ['rename-window', '-t', firstWindowTarget, windowDef.name])
    } else {
      await execTmux(hostId, ['new-window', '-t', sessionName, '-n', windowDef.name])
    }
    const { windowTarget, panes } = windowDef
    const paneBaseIndex = i === 0 ? await getFirstPaneIndex(hostId, firstWindowTarget) : await getFirstPaneIndex(hostId, windowTarget)
    for (let p = 1; p < panes.length; p++) {
      await execTmux(hostId, ['split-window', '-c', '#{pane_current_path}', '-t', windowTarget, splitFlag])
    }
    await execTmux(hostId, ['select-layout', '-t', windowTarget, layoutPreset])
    for (let p = 0; p < panes.length; p++) {
      const command = panes[p]?.command?.trim()
      if (!command) continue
      await runSendKeys(hostId, `${windowTarget}.${paneBaseIndex + p}`, command)
    }
  }
  await execTmux(hostId, ['select-window', '-t', firstWindowTarget])
}
async function cleanupSession(hostId: string, sessionName: string) {
  try {
    await execTmux(hostId, ['kill-session', '-t', sessionName])
  } catch {}
}
async function safePrepareSessionAttach(hostId: string, sessionName: string) {
  if (hostId !== 'local') return
  await prepareSessionAttach(sessionName)
}
export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return getHostTmuxSessions(hostId)
  })
  fastify.get('/hosts/:hostId/session-thumbnails', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return { sessions: await getSessionThumbnails(hostId) }
  })
  fastify.post('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { name, layout } = request.body as { name: string; layout?: SessionTemplateLayout }
    if (!isValidSessionName(name)) throw new Error('Invalid session name')
    try {
      const existingSessions = await getHostTmuxSessions(hostId)
      const existingSession = existingSessions.find((s) => s.name === name)
      if (existingSession) {
        await safePrepareSessionAttach(hostId, existingSession.name)
        return existingSession
      }
      assertSessionAllowed(name)
      await execTmux(hostId, ['new-session', '-d', '-s', name])
      if (layout?.windows?.length) {
        try {
          await applyTemplateLayout(hostId, name, layout)
        } catch (err: any) {
          await cleanupSession(hostId, name)
          throw new Error(err?.message || 'Template layout failed')
        }
      }
      await safePrepareSessionAttach(hostId, name)
      const sessions = await getHostTmuxSessions(hostId)
      return sessions.find((s) => s.name === name) || {
        id: buildSessionId(hostId, name),
        hostId,
        name,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      }
    } catch (err: any) {
      if (String(err?.message || '').includes('duplicate session')) {
        const sessions = await getHostTmuxSessions(hostId)
        const existingSession = sessions.find((s) => s.name === name)
        if (existingSession) return existingSession
      }
      throw new Error(err.message)
    }
  })
  fastify.post('/hosts/:hostId/sessions/rename', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { sessionId, name } = request.body as { sessionId: string; name: string }
    const sessionName = normalizeSessionName(hostId, sessionId)
    if (!isValidSessionName(name)) throw new Error('Invalid session name')
    assertSessionAllowed(sessionName)
    assertSessionAllowed(name)
    try {
      await execTmux(hostId, ['rename-session', '-t', sessionName, name])
      await safePrepareSessionAttach(hostId, name)
      const sessions = await getHostTmuxSessions(hostId)
      return sessions.find((session) => session.name === name) || {
        id: buildSessionId(hostId, name),
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
    const { hostId } = request.params as { hostId: string }
    const body = (request.body || {}) as BatchDeleteRequest
    const mode: BatchDeleteMode = body.mode === 'execute' ? 'execute' : 'preview'
    const limit = normalizeBatchLimit(body.limit)
    const sessions = await getHostTmuxSessions(hostId)
    const { matched, eligible, skipped } = getBatchDeleteSelection(hostId, sessions, body)
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
    if (forceRequired && body.force !== true) throw new Error(`Delete candidate count ${eligible.length} exceeds limit ${limit}, set force=true to continue`)
    const targets = forceRequired && body.force === true ? eligible : limited
    const deleted: BatchDeleteTarget[] = []
    const failed: BatchDeleteSkip[] = []
    for (const session of targets) {
      try {
        await execTmux(hostId, ['kill-session', '-t', session.name])
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
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = normalizeSessionName(hostId, sessionId)
    assertSessionAllowed(sessionName)
    try {
      await execTmux(hostId, ['kill-session', '-t', sessionName])
      return { success: true, sessionId: buildSessionId(hostId, sessionName) }
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
