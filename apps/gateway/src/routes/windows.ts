import type { FastifyInstance } from 'fastify'
import { getNormalizedWindowMoves } from '../lib/template-utils.js'
import { assertSessionAllowed, assertTargetAllowed } from '../lib/tmux-policy.js'
import { buildSessionId, parseSessionRef } from '../lib/tmux-target.js'
import { execTmux } from '../lib/tmux-executor.js'

function parseSessionName(hostId: string, sessionRef: string) {
  return parseSessionRef(hostId, sessionRef).sessionName
}
async function getTmuxWindows(hostId: string, sessionName: string) {
  assertSessionAllowed(sessionName)
  try {
    const { stdout } = await execTmux(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_id}|#{window_index}|#{window_name}|#{window_active}'])
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active] = line.split('|')
        return {
          id: `${hostId}:${id}`,
          tmuxWindowId: id,
          sessionId: buildSessionId(hostId, sessionName),
          index: parseInt(index, 10),
          name,
          active: active === '1',
        }
      })
  } catch (err) {
    console.error('Failed to list tmux windows:', err)
    return []
  }
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
  try {
    const { stdout } = await execTmux(hostId, ['list-panes', '-t', `${sessionName}:${windowIndex}`, '-F', '#{pane_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}'])
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, title, active, width, height, left, top] = line.split('|')
        return {
          id: `${hostId}:${id}`,
          tmuxPaneId: id,
          windowId: `${hostId}:${sessionName}:${windowIndex}`,
          index: parseInt(index, 10),
          title: title || 'shell',
          active: active === '1',
          left: parseInt(left, 10) || 0,
          top: parseInt(top, 10) || 0,
          size: {
            cols: parseInt(width, 10) || 80,
            rows: parseInt(height, 10) || 24,
          },
        }
      })
  } catch (err) {
    console.error('Failed to list tmux panes:', err)
    return []
  }
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
    const windows = await getTmuxWindows(hostId, sessionName)
    const allPanesNested = await Promise.all(windows.map(async (window) => {
      const panes = await getTmuxPanes(hostId, sessionName, window.index)
      return panes.map((pane) => ({
        ...pane,
        windowName: window.name,
      }))
    }))
    return allPanesNested.flat()
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/snapshot', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = parseSessionName(hostId, sessionId)
    const windows = await getTmuxWindows(hostId, sessionName)
    const panesNested = await Promise.all(windows.map(async (window) => {
      const panes = await getTmuxPanes(hostId, sessionName, window.index)
      return panes.map((pane) => ({
        ...pane,
        windowName: window.name,
      }))
    }))
    const panes = panesNested.flat()
    const activeWindow = windows.find((window) => window.active) || windows[0] || null
    const activePane = panes.find((pane) => pane.active) || panes[0] || null
    return { sessionId: buildSessionId(hostId, sessionName), sessionName, windows, panes, activeWindowId: activeWindow?.id || null, activePaneId: activePane?.id || null }
  })
  fastify.get('/panes/:paneId/output', async (request) => {
    const { paneId } = request.params as { paneId: string }
    try {
      const sep = paneId.indexOf(':')
      if (sep <= 0 || sep === paneId.length - 1) throw new Error('Invalid pane id')
      const hostId = paneId.slice(0, sep)
      const tmuxPaneId = await parsePaneTarget(hostId, paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const { stdout } = await execTmux(hostId, ['capture-pane', '-pt', tmuxPaneId, '-p'])
      return { paneId, tmuxPaneId, data: stdout }
    } catch {
      return { paneId, data: '' }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { name } = request.body as { name: string }
    const sessionName = parseSessionName(hostId, sessionId)
    assertSessionAllowed(sessionName)
    try {
      await execTmux(hostId, ['new-window', '-t', sessionName, '-n', name || 'new-window'])
      const windows = await getTmuxWindows(hostId, sessionName)
      return windows[windows.length - 1]
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
