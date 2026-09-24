import type { FastifyInstance } from 'fastify'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { execTmux } from '../lib/tmux-executor.js'
import { markAgentPaneSeen } from '../lib/agent-state.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import {
  paneIdBodySchema,
  paneResizeBodySchema,
  paneSelectBodySchema,
  paneSplitBodySchema,
} from '../lib/request-validation.js'

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
    const { paneId, keepZoom } = paneSelectBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      try {
        // keepZoom → select-pane -Z（tmux>=3.3）：zoom 状态下直接换 zoomed pane，
        // 不退出 zoom（移动端 zoom 全屏翻页依赖该语义）；未 zoom 时 -Z 为 no-op
        await execTmux(hostId, keepZoom ? ['select-pane', '-Z', '-t', tmuxPaneId] : ['select-pane', '-t', tmuxPaneId])
      } catch (err) {
        if (!keepZoom) throw err
        // -Z 缺失的旧版 tmux 回落：select 会 unzoom，按当前 zoom flag 补回 -Z
        await execTmux(hostId, ['select-pane', '-t', tmuxPaneId])
        const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', tmuxPaneId, '#{window_zoomed_flag}'])
        if (stdout.trim() !== '1') await execTmux(hostId, ['resize-pane', '-Z', '-t', tmuxPaneId])
      }
      agentMonitor.markSeen(paneId) || markAgentPaneSeen(paneId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/cwd', async (request) => {
    const { paneId } = paneIdBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', tmuxPaneId, '#{pane_current_path}'])
      return { ok: true, cwd: stdout.trim() }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/split', async (request) => {
    const { paneId, direction } = paneSplitBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execTmux(hostId, [
        'split-window',
        '-c',
        '#{pane_current_path}',
        '-e',
        'TMUXGO_ENV=1',
        '-t',
        tmuxPaneId,
        flag,
      ])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/zoom', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      // 禁止无目标调用：gateway 自身跑在 tmux 内，裸 resize-pane 会命中 gateway 所在 pane
      if (!paneId) throw new Error('paneId is required')
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      await execTmux(hostId, ['resize-pane', '-Z', '-t', tmuxPaneId])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  fastify.post('/panes/resize', async (request) => {
    const { paneId, cols, rows } = paneResizeBodySchema.parse(request.body)
    try {
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
      // 禁止无目标调用：gateway 自身跑在 tmux 内，裸 kill-pane 会杀掉 gateway 所在
      // pane；若恰好是最后 window 的最后 pane，会连带销毁 session 甚至 tmux server
      if (!paneId) throw new Error('paneId is required')
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      await execTmux(hostId, ['kill-pane', '-t', tmuxPaneId])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
