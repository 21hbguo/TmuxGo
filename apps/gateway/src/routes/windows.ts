import type { FastifyInstance } from 'fastify'
import { getNormalizedWindowMoves } from '../lib/template-utils.js'
import { assertSessionAllowed, assertTargetAllowed } from '../lib/tmux-policy.js'
import { buildSessionId, parseSessionRef } from '../lib/tmux-target.js'
import { execTmux } from '../lib/tmux-executor.js'
import { recordStreamMetric } from '../lib/perf-metrics.js'
import { getSessionAgentPanes, markAgentPaneSeen } from '../lib/agent-state.js'

function parseSessionName(hostId: string, sessionRef: string) {
  return parseSessionRef(hostId, sessionRef).sessionName
}
async function getTmuxWindows(hostId: string, sessionName: string) {
  assertSessionAllowed(sessionName)
  const { stdout } = await execTmux(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}'])
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, index, name, active, zoomed] = line.split('|')
      return {
        id: `${hostId}:${id}`,
        tmuxWindowId: id,
        sessionId: buildSessionId(hostId, sessionName),
        index: parseInt(index, 10),
        name,
        active: active === '1',
        zoomed: zoomed === '1',
      }
    })
}
async function normalizeWindowOrder(hostId: string, sessionName: string, orderedWindowIds: string[]) {
  assertSessionAllowed(sessionName)
  const tmuxOrderedIds = orderedWindowIds.map((item) => {
    if (!item.startsWith(`${hostId}:`)) throw new Error('Window does not belong to host')
    return item.slice(hostId.length + 1)
  })
  for (const move of getNormalizedWindowMoves(sessionName, tmuxOrderedIds)) {
    if (hostId === 'local') await assertTargetAllowed(move.source, sessionName)
    await execTmux(hostId, ['move-window', '-s', move.source, '-t', move.target])
  }
}
async function getTmuxPanes(hostId: string, sessionName: string, windowIndex: number) {
  assertSessionAllowed(sessionName)
  const [{ stdout }, agentPanes] = await Promise.all([
    execTmux(hostId, ['list-panes', '-t', `${sessionName}:${windowIndex}`, '-F', '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}']),
    getSessionAgentPanes(hostId, sessionName),
  ])
  const agentByPane = new Map(agentPanes.map((pane) => [pane.paneId, pane]))
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, windowId, index, title, active, width, height, left, top] = line.split('|')
      const paneId = `${hostId}:${id}`
      const agentState = agentByPane.get(paneId)
      return {
        id: paneId,
        tmuxPaneId: id,
        windowId: `${hostId}:${windowId}`,
        index: parseInt(index, 10),
        title: title || 'shell',
        active: active === '1',
        left: parseInt(left, 10) || 0,
        top: parseInt(top, 10) || 0,
        size: {
          cols: parseInt(width, 10) || 80,
          rows: parseInt(height, 10) || 24,
        },
        ...(agentState ? { agent: agentState.agent, agentStatus: agentState.agentStatus, revision: agentState.revision } : {}),
      }
    })
}
async function getTmuxSessionPanes(hostId: string, sessionName: string) {
  assertSessionAllowed(sessionName)
  const [{ stdout }, agentPanes] = await Promise.all([
    execTmux(hostId, ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{window_name}']),
    getSessionAgentPanes(hostId, sessionName),
  ])
  const agentByPane = new Map(agentPanes.map((pane) => [pane.paneId, pane]))
  return stdout.trim().split('\n').filter(Boolean).map((line) => line.split('|')).map(([id, windowId, index, title, active, width, height, left, top, windowName]) => {
    const paneId = `${hostId}:${id}`
    const agentState = agentByPane.get(paneId)
    return {
      id: paneId,
      tmuxPaneId: id,
      windowId: `${hostId}:${windowId}`,
      index: parseInt(index, 10),
      title: title || 'shell',
      active: active === '1',
      left: parseInt(left, 10) || 0,
      top: parseInt(top, 10) || 0,
      size: { cols: parseInt(width, 10) || 80, rows: parseInt(height, 10) || 24 },
      windowName,
      ...(agentState ? { agent: agentState.agent, agentStatus: agentState.agentStatus, revision: agentState.revision } : {}),
    }
  })
}
function parseWindowRef(hostId: string, windowRef: string) {
  if (!windowRef.startsWith(`${hostId}:`)) throw new Error('Window does not belong to host')
  const value = windowRef.slice(hostId.length + 1)
  if (!value.startsWith('@')) throw new Error('Invalid window id')
  return value
}
function parseWindowRouteParam(windowId: string) {
  const sep = windowId.indexOf(':')
  if (sep <= 0 || sep === windowId.length - 1) throw new Error('Invalid window id')
  const hostId = windowId.slice(0, sep)
  const windowName = windowId.slice(sep + 1)
  if (!windowName.startsWith('@')) throw new Error('Invalid window id')
  return { hostId, windowName }
}
async function parsePaneTarget(hostId: string, paneId: string) {
  if (!paneId.startsWith(`${hostId}:`)) throw new Error('Pane does not belong to host')
  const tmuxPaneId = paneId.slice(hostId.length + 1)
  if (!tmuxPaneId.startsWith('%')) throw new Error('Invalid pane id')
  return tmuxPaneId
}
export async function windowRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    return getTmuxWindows(hostId, sessionName)
  })
  fastify.get('/windows/:windowId/panes', async (request) => {
    const { windowId } = request.params as { windowId: string }
    const { hostId, windowName } = parseWindowRouteParam(windowId)
    const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', windowName, '#{session_name}|#{window_index}'])
    const [sessionName, windowIndexText] = stdout.trim().split('|')
    const windowIndex = parseInt(windowIndexText, 10)
    if (!sessionName || !Number.isFinite(windowIndex)) return []
    return getTmuxPanes(hostId, sessionName, windowIndex)
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/panes', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    return getTmuxSessionPanes(hostId, sessionName)
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/snapshot', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    recordStreamMetric('snapshotRequests')
    const [windows, panes] = await Promise.all([getTmuxWindows(hostId, sessionName), getTmuxSessionPanes(hostId, sessionName)])
    const activeWindow = windows.find((window) => window.active) || windows[0] || null
    const activePane = panes.find((pane) => pane.windowId === activeWindow?.id && pane.active) || panes.find((pane) => pane.windowId === activeWindow?.id) || null
    if (activePane) {
      const seen = markAgentPaneSeen(activePane.id)
      if (seen) Object.assign(activePane, { agent: seen.agent, agentStatus: seen.agentStatus, revision: seen.revision })
    }
    return { sessionId: buildSessionId(hostId, sessionName), sessionName, windows, panes, activeWindowId: activeWindow?.id || null, activePaneId: activePane?.id || null }
  })
  fastify.get('/panes/:paneId/output', async (request) => {
    const { paneId } = request.params as { paneId: string }
    const sep = paneId.indexOf(':')
    if (sep <= 0 || sep === paneId.length - 1) throw new Error('Invalid pane id')
    const hostId = paneId.slice(0, sep)
    const tmuxPaneId = await parsePaneTarget(hostId, paneId)
    if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
    const { stdout } = await execTmux(hostId, ['capture-pane', '-pt', tmuxPaneId, '-p'])
    return { paneId, tmuxPaneId, data: stdout }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { name } = request.body as { name: string }
    const sessionName = parseSessionName(hostId, sessionId)
    assertSessionAllowed(sessionName)
    try {
      const { stdout } = await execTmux(hostId, ['new-window', '-P', '-F', '#{window_id}', '-t', sessionName, '-n', name || 'new-window'])
      const createdWindowId = stdout.trim()
      const windows = await getTmuxWindows(hostId, sessionName)
      return windows.find((window) => window.tmuxWindowId === createdWindowId) || windows.find((window) => window.active)
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/select', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId } = request.body as { windowId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    const tmuxWindowId = parseWindowRef(hostId, windowId)
    try {
      assertSessionAllowed(sessionName)
      if (hostId === 'local') await assertTargetAllowed(tmuxWindowId, sessionName)
      await execTmux(hostId, ['select-window', '-t', tmuxWindowId])
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/rename', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId, name } = request.body as { windowId: string; name: string }
    const sessionName = parseSessionName(hostId, sessionId)
    const tmuxWindowId = parseWindowRef(hostId, windowId)
    try {
      assertSessionAllowed(sessionName)
      if (hostId === 'local') await assertTargetAllowed(tmuxWindowId, sessionName)
      await execTmux(hostId, ['rename-window', '-t', tmuxWindowId, name])
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/move', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { orderedWindowIds } = request.body as { orderedWindowIds?: string[] }
    const sessionName = parseSessionName(hostId, sessionId)
    try {
      assertSessionAllowed(sessionName)
      if (!orderedWindowIds?.length) throw new Error('orderedWindowIds is required')
      await normalizeWindowOrder(hostId, sessionName, orderedWindowIds)
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/kill', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId } = request.body as { windowId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    const tmuxWindowId = parseWindowRef(hostId, windowId)
    try {
      assertSessionAllowed(sessionName)
      if (hostId === 'local') await assertTargetAllowed(tmuxWindowId, sessionName)
      await execTmux(hostId, ['kill-window', '-t', tmuxWindowId])
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/windows/:windowId/panes', async (request) => {
    const { windowId } = request.params as { windowId: string }
    const { direction } = request.body as { direction: 'horizontal' | 'vertical' }
    const { hostId, windowName } = parseWindowRouteParam(windowId)
    const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', windowName, '#{session_name}|#{window_index}'])
    const [sessionName, windowIndexText] = stdout.trim().split('|')
    const windowIndex = parseInt(windowIndexText, 10)
    if (!sessionName || !Number.isFinite(windowIndex)) throw new Error('Invalid window target')
    assertSessionAllowed(sessionName)
    try {
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execTmux(hostId, ['split-window', '-c', '#{pane_current_path}', '-t', `${sessionName}:${windowIndex}`, flag])
      const panes = await getTmuxPanes(hostId, sessionName, windowIndex)
      return panes[panes.length - 1]
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
