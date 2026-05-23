import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export async function paneRoutes(fastify: FastifyInstance) {
  fastify.post('/panes/zoom', async (request) => {
    const { session } = request.body as { session?: string }
    try {
      const args = ['resize-pane', '-Z']
      if (session) args.push('-t', session)
      await execFileAsync('tmux', args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  fastify.post('/panes/kill', async (request) => {
    const { session } = request.body as { session?: string }
    try {
      const args = ['kill-pane']
      if (session) args.push('-t', session)
      await execFileAsync('tmux', args)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
