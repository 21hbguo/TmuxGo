import type { FastifyInstance } from 'fastify'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

async function getTmuxWindows(sessionName: string) {
  try {
    const { stdout } = await execAsync(
      `tmux list-windows -t ${sessionName} -F "#{window_id}|#{window_index}|#{window_name}|#{window_active}"`
    )

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active] = line.split('|')
        return {
          id: `window-${sessionName}-${index}`,
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

async function getTmuxPanes(sessionName: string, windowIndex: number) {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t ${sessionName}:${windowIndex} -F "#{pane_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}"`
    )

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, title, active, width, height] = line.split('|')
        return {
          id: `pane-${sessionName}-${windowIndex}-${index}`,
          windowId: `window-${sessionName}-${windowIndex}`,
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
    const allPanes: any[] = []

    for (const window of windows) {
      const panes = await getTmuxPanes(sessionName, window.index)
      allPanes.push(...panes.map((pane) => ({
        ...pane,
        windowName: window.name,
      })))
    }

    return allPanes
  })

  fastify.post('/hosts/:hostId/sessions/:sessionId/windows', async (request) => {
    const { sessionId } = request.params as { sessionId: string }
    const { name } = request.body as { name: string }
    const sessionName = sessionId.replace('session-', '')

    try {
      await execAsync(`tmux new-window -t ${sessionName} -n ${name || 'new-window'}`)
      const windows = await getTmuxWindows(sessionName)
      return windows[windows.length - 1]
    } catch (err: any) {
      throw new Error(err.message)
    }
  })

  fastify.post('/windows/:windowId/panes', async (request) => {
    const { windowId } = request.params as { windowId: string }
    const { direction } = request.body as { direction: 'horizontal' | 'vertical' }
    const parts = windowId.split('-')
    const sessionName = parts[1]
    const windowIndex = parseInt(parts[2], 10)

    try {
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execAsync(`tmux split-window -t ${sessionName}:${windowIndex} ${flag}`)
      const panes = await getTmuxPanes(sessionName, windowIndex)
      return panes[panes.length - 1]
    } catch (err: any) {
      throw new Error(err.message)
    }
  })
}
