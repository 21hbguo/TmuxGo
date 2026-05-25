import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { assertTargetAllowed } from '../lib/tmux-policy.js'

const execFileAsync = promisify(execFile)

export async function paneRoutes(fastify: FastifyInstance) {
  fastify.post('/panes/select', async (request) => {
    const { paneId } = request.body as { paneId: string }
    try {
      await assertTargetAllowed(paneId)
      await execFileAsync('tmux', ['select-pane', '-t', paneId])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/split', async (request) => {
    const { paneId, direction } = request.body as { paneId: string; direction: 'horizontal' | 'vertical' }
    try {
      await assertTargetAllowed(paneId)
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execFileAsync('tmux', ['split-window', '-t', paneId, flag])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/zoom', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      const args = ['resize-pane', '-Z']
      if (paneId) {
        await assertTargetAllowed(paneId)
        args.push('-t', paneId)
      }
      await execFileAsync('tmux', args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  fastify.post('/panes/kill', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      const args = ['kill-pane']
      if (paneId) {
        await assertTargetAllowed(paneId)
        args.push('-t', paneId)
      }
      await execFileAsync('tmux', args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
