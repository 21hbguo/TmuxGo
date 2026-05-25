import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getNormalizedWindowMoves } from '../lib/template-utils.js'

const execFileAsync = promisify(execFile)

async function getTmuxWindows(sessionName: string) {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_id}|#{window_index}|#{window_name}|#{window_active}'])

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active] = line.split('|')
        return {
          id: id,
          tmuxWindowId: id,
          sessionId: `session-${sessionName}`,
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
async function normalizeWindowOrder(sessionName: string, orderedWindowIds: string[]) {
  for (const move of getNormalizedWindowMoves(sessionName, orderedWindowIds)) {
    await execFileAsync('tmux', ['move-window', '-s', move.source, '-t', move.target])
  }
}

async function getTmuxPanes(sessionName: string, windowIndex: number) {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-t', `${sessionName}:${windowIndex}`, '-F', '#{pane_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}'])

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, title, active, width, height] = line.split('|')
        return {
          id: id,
          tmuxPaneId: id,
          windowId: `${sessionName}:${windowIndex}`,
          index: parseInt(index, 10),
          title: title || 'shell',
          active: active === '1',
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

export async function windowRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = sessionId.replace('session-', '')
    return getTmuxWindows(sessionName)
  })

  fastify.get('/windows/:windowId/panes', async (request) => {
    const { windowId } = request.params as { windowId: string }
    const parts = windowId.split('-')
    const sessionName = parts[1]
    const windowIndex = parseInt(parts[2], 10)
    return getTmuxPanes(sessionName, windowIndex)
  })

  fastify.get('/hosts/:hostId/sessions/:sessionId/panes', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = sessionId.replace('session-', '')
    const windows = await getTmuxWindows(sessionName)
    const allPanesNested = await Promise.all(windows.map(async (window) => {
      const panes = await getTmuxPanes(sessionName, window.index)
      return panes.map((pane) => ({
        ...pane,
        windowName: window.name,
      }))
    }))
    const allPanes = allPanesNested.flat()
    return allPanes
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/snapshot', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = sessionId.replace('session-', '')
    const windows = await getTmuxWindows(sessionName)
    const panesNested = await Promise.all(windows.map(async (window) => {
      const panes = await getTmuxPanes(sessionName, window.index)
      return panes.map((pane) => ({
        ...pane,
        windowName: window.name,
      }))
    }))
    const panes = panesNested.flat()
    const activeWindow = windows.find((window) => window.active) || windows[0] || null
    const activePane = panes.find((pane) => pane.active) || panes[0] || null
    return { sessionId, sessionName, windows, panes, activeWindowId: activeWindow?.id || null, activePaneId: activePane?.id || null }
  })

  fastify.get('/panes/:paneId/output', async (request) => {
    const { paneId } = request.params as { paneId: string }
    try {
      const { stdout } = await execFileAsync('tmux', ['capture-pane', '-pt', paneId, '-p'])
      return { paneId, tmuxPaneId: paneId, data: stdout }
    } catch (err: any) {
      return { paneId, tmuxPaneId: paneId, data: '' }
    }
  })

  fastify.post('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { name } = request.body as { name: string }
    const sessionName = sessionId.replace('session-', '')

    try {
      await execFileAsync('tmux', ['new-window', '-t', sessionName, '-n', name || 'new-window'])
      const windows = await getTmuxWindows(sessionName)
      return windows[windows.length - 1]
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/select', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { windowId } = request.body as { windowId: string }
    const sessionName = sessionId.replace('session-', '')
    try {
      await execFileAsync('tmux', ['select-window', '-t', windowId])
      const windows = await getTmuxWindows(sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/rename', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { windowId, name } = request.body as { windowId: string; name: string }
    const sessionName = sessionId.replace('session-', '')
    try {
      await execFileAsync('tmux', ['rename-window', '-t', windowId, name])
      const windows = await getTmuxWindows(sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/move', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { orderedWindowIds } = request.body as { orderedWindowIds?: string[] }
    const sessionName = sessionId.replace('session-', '')
    try {
      if (!orderedWindowIds?.length) {
        throw new Error('orderedWindowIds is required')
      }
      await normalizeWindowOrder(sessionName, orderedWindowIds)
      const windows = await getTmuxWindows(sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/kill', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { windowId } = request.body as { windowId: string }
    const sessionName = sessionId.replace('session-', '')
    try {
      await execFileAsync('tmux', ['kill-window', '-t', windowId])
      const windows = await getTmuxWindows(sessionName)
      return { ok: true, windows }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  fastify.post('/windows/:windowId/panes', async (request) => {
    const { windowId } = request.params as { windowId: string }
    const { direction } = request.body as { direction: 'horizontal' | 'vertical' }
    const parts = windowId.split(':')
    const sessionName = parts[0]
    const windowIndex = parseInt(parts[1], 10)

    try {
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execFileAsync('tmux', ['split-window', '-t', `${sessionName}:${windowIndex}`, flag])
      const panes = await getTmuxPanes(sessionName, windowIndex)
      return panes[panes.length - 1]
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
