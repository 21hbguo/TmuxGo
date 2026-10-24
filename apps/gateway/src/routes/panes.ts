import type { FastifyInstance } from 'fastify'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { execTmux } from '../lib/tmux-executor.js'
import { AgentExplainError, explainAgentPane, markAgentPaneSeen } from '../lib/agent-state.js'
import { appendAuditEvent } from '../lib/audit-log.js'
import { getRequestPrincipal } from '../lib/principal.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import {
  paneCopySelectionBodySchema,
  paneIdBodySchema,
  paneMarkSeenBodySchema,
  paneResizeBodySchema,
  paneSelectBodySchema,
  paneSplitBodySchema,
  paneTaskBodySchema,
} from '../lib/request-validation.js'

// catch 到的值不保证是 Error（tmux/SSH 通道可能抛字符串），统一收窄取文案
function errorMessage(error: unknown, fallback = '') {
  return error instanceof Error && error.message ? error.message : fallback
}

function parsePaneId(paneId: string) {
  const separator = paneId.indexOf(':')
  if (separator <= 0 || separator === paneId.length - 1) throw new Error('Invalid pane id')
  const hostId = paneId.slice(0, separator)
  const tmuxPaneId = paneId.slice(separator + 1)
  if (!tmuxPaneId.startsWith('%')) throw new Error('Invalid pane id')
  return { hostId, tmuxPaneId }
}
export async function paneRoutes(fastify: FastifyInstance) {
  // agent 判定解释（按需重算，不进 monitor 热路径）：给「这条 pane 为什么被判成这个状态」
  // 一个可核对的答案——判定来源、命中的 manifest/规则、fallback 原因。
  // 只读且不触碰 pane，故用 GET；输出不含屏幕内容，只有标签与规则元数据。
  // paneId 走 query 而不是 path 段：tmux pane id 自带 `%`，裸 `%1` 在路径里是非法 URL
  // 组件（要求客户端编码成 %251 属于坑），query 值按普通查询参数解码，curl 直用
  fastify.get('/hosts/:hostId/panes/agent-explain', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const paneId = String((request.query as { paneId?: string }).paneId ?? '')
    const [paneHost, tmuxPaneId] = paneId.split(':')
    const target = paneHost === hostId ? tmuxPaneId || '' : ''
    if (!/^%[0-9]+$/.test(target))
      return reply.code(400).send({ ok: false, code: 'INVALID_PANE_ID', message: 'paneId must be <host>:%n' })
    try {
      await assertTargetAllowed(hostId, target)
    } catch (error) {
      const message = errorMessage(error)
      const forbidden = /not allowed/i.test(message)
      return reply
        .code(forbidden ? 403 : 404)
        .send({ ok: false, code: forbidden ? 'SESSION_NOT_ALLOWED' : 'PANE_MISSING', message })
    }
    try {
      const result = await explainAgentPane(hostId, target)
      reply.header('cache-control', 'no-store')
      return { ok: true, ...result }
    } catch (error) {
      if (error instanceof AgentExplainError)
        return reply.code(error.code === 'PANE_MISSING' ? 404 : 502).send({
          ok: false,
          code: error.code,
          message: error.message,
        })
      return reply.code(502).send({ ok: false, code: 'PANE_CAPTURE_FAILED', message: errorMessage(error) })
    }
  })
  fastify.post('/panes/select', async (request) => {
    const { paneId, keepZoom } = paneSelectBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
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
      if (!agentMonitor.markSeen(paneId)) markAgentPaneSeen(paneId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  // 显式「标记已查看」入口：done→idle 幂等，不做 tmux select 副作用；
  // paneId/paneIds 均接受，非 done 状态原样返回不计入 marked
  fastify.post('/panes/mark-seen', async (request) => {
    const body = paneMarkSeenBodySchema.parse(request.body)
    const paneIds = [...new Set([...(body.paneIds || []), ...(body.paneId ? [body.paneId] : [])])]
    let marked = 0
    for (const paneId of paneIds) {
      parsePaneId(paneId)
      if (agentMonitor.markSeen(paneId) || markAgentPaneSeen(paneId)) marked += 1
    }
    return { ok: true, marked }
  })
  // mouse on 时终端拖选全部归 tmux copy-mode：选区坐标只在 tmux 侧，
  // 前端轮询此端点拿 pane 相对坐标，再用本地 buffer 切片算实时字符数
  fastify.post('/panes/selection-state', async (request) => {
    const { paneId } = paneIdBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
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
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  // 拖选松手后 tmux 经 copy-selection-and-cancel 落最新 paste buffer：浏览器拿不到
  // release 事件对应的文本，靠"比对 since 之前的最新 buffer 名"等它落盘后回传。
  // since 省略时直接返回当前最新 buffer（arm 时取基线用）
  fastify.post('/panes/copy-selection', async (request) => {
    const { paneId, since, peek } = paneCopySelectionBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
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
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/panes/cwd', async (request) => {
    const { paneId } = paneIdBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', tmuxPaneId, '#{pane_current_path}'])
      return { ok: true, cwd: stdout.trim() }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/panes/split', async (request) => {
    const { paneId, direction } = paneSplitBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
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
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/panes/zoom', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      // 禁止无目标调用：gateway 自身跑在 tmux 内，裸 resize-pane 会命中 gateway 所在 pane
      if (!paneId) throw new Error('paneId is required')
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      await execTmux(hostId, ['resize-pane', '-Z', '-t', tmuxPaneId])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/panes/resize', async (request) => {
    const { paneId, cols, rows } = paneResizeBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      const args = ['resize-pane', '-t', tmuxPaneId]
      if (typeof cols === 'number' && Number.isFinite(cols)) args.push('-x', String(Math.max(2, Math.round(cols))))
      if (typeof rows === 'number' && Number.isFinite(rows)) args.push('-y', String(Math.max(2, Math.round(rows))))
      if (args.length <= 3) return { ok: true }
      await execTmux(hostId, args)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/panes/kill', async (request) => {
    const { paneId } = request.body as { paneId?: string }
    try {
      // 禁止无目标调用：gateway 自身跑在 tmux 内，裸 kill-pane 会杀掉 gateway 所在
      // pane；若恰好是最后 window 的最后 pane，会连带销毁 session 甚至 tmux server
      if (!paneId) throw new Error('paneId is required')
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      await execTmux(hostId, ['kill-pane', '-t', tmuxPaneId])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  // pane ↔ 任务号绑定：写进 pane user-option @tmuxgo_task，列表接口读回 Pane.task。
  // 存 user-option 而不是自建表：tmux 自身是权威源，pane 关掉即随 pane 消失，
  // 不需要额外 GC；外部工具（tmux-comm/脚本）也能直接 set-option 写同一个位置。
  fastify.post('/panes/task', async (request) => {
    const { paneId, task } = paneTaskBodySchema.parse(request.body)
    const trimmed = task.trim()
    const audit = (result: 'success' | 'failure', hostId?: string) => {
      const principal = getRequestPrincipal(request)
      void appendAuditEvent({
        id: `${Date.now().toString(36)}-${request.id}`,
        timestamp: new Date().toISOString(),
        user: principal.actor,
        actor: principal.actor,
        source: principal.source,
        action: trimmed ? 'pane-task-set' : 'pane-task-clear',
        target: paneId,
        result,
        method: request.method,
        statusCode: result === 'success' ? 200 : 400,
        hostId,
        message: trimmed || undefined,
      }).catch(() => {})
    }
    try {
      const { hostId, tmuxPaneId } = parsePaneId(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      // 空 task = 解绑。用 -u 删掉 option 而不是写入空串：空串会在 show-options 里
      // 留下一条 @tmuxgo_task ""，外部工具按「存在即绑定」判断时会误判
      await execTmux(
        hostId,
        trimmed
          ? ['set-option', '-p', '-t', tmuxPaneId, '@tmuxgo_task', trimmed]
          : ['set-option', '-u', '-p', '-t', tmuxPaneId, '@tmuxgo_task'],
      )
      audit('success', hostId)
      return { ok: true, paneId, task: trimmed || null }
    } catch (err) {
      audit('failure')
      return { ok: false, error: errorMessage(err) }
    }
  })
}
