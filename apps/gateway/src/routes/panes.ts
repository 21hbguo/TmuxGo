import type { FastifyInstance } from 'fastify'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { execTmux } from '../lib/tmux-executor.js'
import { markAgentPaneSeen } from '../lib/agent-state.js'

function parsePaneId(paneId: string) {
  const separator = paneId.indexOf(':')
  if (separator <= 0 || separator === paneId.length - 1) throw new Error('Invalid pane id')
  const hostId = paneId.slice(0, separator)
  const tmuxPaneId = paneId.slice(separator + 1)
  if (!tmuxPaneId.startsWith('%')) throw new Error('Invalid pane id')
  return { hostId, tmuxPaneId }
}
export async function paneRoutes(fastify: FastifyInstance) {
  fastify.post('/panes/select', async (request) => {
    const { paneId } = request.body as { paneId: string }
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      await execTmux(hostId, ['select-pane', '-t', tmuxPaneId])
      markAgentPaneSeen(paneId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/split', async (request) => {
    const { paneId, direction } = request.body as { paneId: string; direction: 'horizontal' | 'vertical' }
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execTmux(hostId, ['split-window', '-c', '#{pane_current_path}', '-t', tmuxPaneId, flag])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/zoom', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      const args = ['resize-pane', '-Z']
      let hostId = 'local'
      if (paneId) {
        const parsed = parsePaneId(paneId)
        hostId = parsed.hostId
        if (hostId === 'local') await assertTargetAllowed(parsed.tmuxPaneId)
        args.push('-t', parsed.tmuxPaneId)
      }
      await execTmux(hostId, args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/resize', async (request) => {
    const { paneId, cols, rows } = request.body as { paneId?: string; cols?: number; rows?: number }
    try {
      if (!paneId) throw new Error('paneId required')
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const args = ['resize-pane', '-t', tmuxPaneId]
      if (typeof cols === 'number' && Number.isFinite(cols)) args.push('-x', String(Math.max(2, Math.round(cols))))
      if (typeof rows === 'number' && Number.isFinite(rows)) args.push('-y', String(Math.max(2, Math.round(rows))))
      if (args.length <= 3) return { ok: true }
      await execTmux(hostId, args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/kill', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      const args = ['kill-pane']
      let hostId = 'local'
      if (paneId) {
        const parsed = parsePaneId(paneId)
        hostId = parsed.hostId
        if (hostId === 'local') await assertTargetAllowed(parsed.tmuxPaneId)
        args.push('-t', parsed.tmuxPaneId)
      }
      await execTmux(hostId, args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
