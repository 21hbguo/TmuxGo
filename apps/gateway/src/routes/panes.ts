import type { FastifyInstance } from 'fastify'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { execTmux } from '../lib/tmux-executor.js'
import { markAgentPaneSeen } from '../lib/agent-state.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import {
  paneCopySelectionBodySchema,
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
  // mouse on 时终端拖选全部归 tmux copy-mode：选区坐标只在 tmux 侧，
  // 前端轮询此端点拿 pane 相对坐标，再用本地 buffer 切片算实时字符数
  fastify.post('/panes/selection-state', async (request) => {
    const { paneId } = paneIdBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const { stdout } = await execTmux(hostId, [
        'display-message',
        '-p',
        '-t',
        tmuxPaneId,
        '#{pane_in_mode}\t#{selection_active}\t#{selection_present}\t#{selection_start_x}\t#{selection_start_y}\t#{selection_end_x}\t#{selection_end_y}\t#{rectangle_toggle}',
      ])
      const [inMode, active, present, sx, sy, ex, ey, rect] = stdout.trim().split('\t')
      return {
        ok: true,
        inCopyMode: inMode === '1',
        selecting: active === '1',
        present: present === '1',
        startX: Number(sx) || 0,
        startY: Number(sy) || 0,
        endX: Number(ex) || 0,
        endY: Number(ey) || 0,
        rectangle: rect === '1',
      }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
  // 拖选松手后 tmux 经 copy-selection-and-cancel 落最新 paste buffer：浏览器拿不到
  // release 事件对应的文本，靠"比对 since 之前的最新 buffer 名"等它落盘后回传。
  // since 省略时直接返回当前最新 buffer（arm 时取基线用）
  fastify.post('/panes/copy-selection', async (request) => {
    const { paneId, since, peek } = paneCopySelectionBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const newestBufferName = async () => {
        const { stdout } = await execTmux(hostId, ['list-buffers', '-F', '#{buffer_name}'])
        return stdout.split('\n')[0]?.trim() || ''
      }
      let name = await newestBufferName()
      if (since !== undefined) {
        const deadline = Date.now() + 900
        while (name === since && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 60))
          name = await newestBufferName()
        }
        if (name === since) return { ok: true, found: false }
      }
      if (!name) return { ok: true, found: false }
      if (peek) return { ok: true, found: true, name }
      const { stdout } = await execTmux(hostId, ['show-buffer', '-b', name])
      return { ok: true, found: true, name, text: stdout }
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
