import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolvePrincipalScope, scopeAllowsSession } from '../lib/access-scope.js'
import { assertSessionAllowed, assertTargetAllowed } from '../lib/tmux-policy.js'
import { execTmux } from '../lib/tmux-executor.js'
import { writePaneTask } from '../lib/pane-task.js'
import { AgentExplainError, explainAgentPane, markAgentPaneSeen } from '../lib/agent-state.js'
import { appendAuditEvent } from '../lib/audit-log.js'
import { getRequestPrincipal } from '../lib/principal.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import {
  buildBreakPaneArgs,
  buildJoinPaneArgs,
  buildSwapPaneArgs,
  classifyPaneTopologyError,
  PaneTopologyError,
  parsePaneRef,
  parseWindowRef,
} from '../lib/pane-topology.js'
import {
  describeZodError,
  paneBreakBodySchema,
  paneCopySelectionBodySchema,
  paneIdBodySchema,
  paneMarkSeenBodySchema,
  paneMoveBodySchema,
  paneResizeBodySchema,
  paneSelectBodySchema,
  paneSplitBodySchema,
  paneSwapBodySchema,
  paneTaskBodySchema,
} from '../lib/request-validation.js'

// catch 到的值不保证是 Error（tmux/SSH 通道可能抛字符串），统一收窄取文案
function errorMessage(error: unknown, fallback = '') {
  return error instanceof Error && error.message ? error.message : fallback
}

// 请求 scope 的 session 判定：全局 accessScopeGuard 只能从 body 的 paneId 抽出 host
// （反查 pane 所属 session 要打一次 tmux，不能在 preHandler 里做），而拓扑编辑会把
// pane 搬进另一个 session，必须自己补这一步——否则受限身份能借目标窗口跨 session 搬 pane。
function assertRequestScopeAllowsSession(request: FastifyRequest, hostId: string, sessionName: string) {
  const scope = resolvePrincipalScope(getRequestPrincipal(request))
  if (scope && !scopeAllowsSession(scope, hostId, sessionName))
    throw new PaneTopologyError('SESSION_NOT_ALLOWED', 'Session is not allowed', 403)
}

type PaneTopologyAction = 'pane-move' | 'pane-break' | 'pane-swap'

// 拓扑动作审计：成功与失败都记，target 统一 <src>→<dst>（break 没有显式目标，
// name 缺省时记 new-window）。与 /panes/task 一致 fire-and-forget，审计落盘失败不反噬动作。
function auditPaneTopology(
  request: FastifyRequest,
  action: PaneTopologyAction,
  target: string,
  result: 'success' | 'failure',
  statusCode: number,
  hostId?: string,
) {
  const principal = getRequestPrincipal(request)
  void appendAuditEvent({
    id: `${Date.now().toString(36)}-${request.id}`,
    timestamp: new Date().toISOString(),
    user: principal.actor,
    actor: principal.actor,
    source: principal.source,
    action,
    target,
    result,
    method: request.method,
    statusCode,
    hostId,
  }).catch(() => {})
}

function topologyFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  action: PaneTopologyAction,
  target: string,
  error: unknown,
  hostId?: string,
) {
  const { statusCode, message } = classifyPaneTopologyError(error)
  auditPaneTopology(request, action, target, 'failure', statusCode, hostId)
  return reply.code(statusCode).send({ ok: false, error: message })
}

// 审计 target 的 <src>→<dst> 片段：坏请求也要留下调用方声明的目标，
// 否则排障时只看到一条没有上下文的 400
function topologyAuditTarget(source: unknown, target: unknown) {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : '-')
  return `${text(source)}→${text(target)}`
}

// 失败审计里的 hostId：参数可能已经坏掉，按第一个能解析出 host 前缀的引用取值，
// 解析不出来就留空（审计行仍保留 src→dst 原文）
function topologyHostOf(...ids: Array<string | undefined>) {
  for (const id of ids) {
    if (!id) continue
    const separator = id.indexOf(':')
    if (separator > 0) return id.slice(0, separator)
  }
  return undefined
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      parsePaneRef(paneId)
      if (agentMonitor.markSeen(paneId) || markAgentPaneSeen(paneId)) marked += 1
    }
    return { ok: true, marked }
  })
  // mouse on 时终端拖选全部归 tmux copy-mode：选区坐标只在 tmux 侧，
  // 前端轮询此端点拿 pane 相对坐标，再用本地 buffer 切片算实时字符数
  fastify.post('/panes/selection-state', async (request) => {
    const { paneId } = paneIdBodySchema.parse(request.body)
    try {
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
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
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      await writePaneTask(hostId, tmuxPaneId, trimmed)
      // 机队视图读的是 monitor 缓存：人类入口写入后也要就地更新，否则面板要等下一轮扫描
      agentMonitor.notePaneTask(hostId, tmuxPaneId, trimmed)
      audit('success', hostId)
      return { ok: true, paneId, task: trimmed || null }
    } catch (err) {
      audit('failure')
      return { ok: false, error: errorMessage(err) }
    }
  })
  // ── pane 拓扑编辑：直接映射 tmux 原生 join-pane / break-pane / swap-pane ──
  // 共同流程：zod 卡字段形状 → build*Args 做语义校验并拼 argv → allowlist 与请求 scope
  // 判定（源 pane、目标 pane/目标窗口所属 session 都要过）→ execTmux。目标 session 必须
  // 反查：window/pane id 本身不带 session，不查就无从判断它在不在允许范围内。
  fastify.post('/panes/move', async (request, reply) => {
    const rawBody = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    const action = 'pane-move'
    const auditTarget = topologyAuditTarget(rawBody.paneId, rawBody.targetPaneId ?? rawBody.targetWindowId)
    const parsed = paneMoveBodySchema.safeParse(request.body)
    if (!parsed.success)
      return topologyFailure(
        request,
        reply,
        action,
        auditTarget,
        new PaneTopologyError('INVALID_REQUEST', describeZodError(parsed.error)),
      )
    const { paneId, targetWindowId, targetPaneId, direction, sizePercent } = parsed.data
    try {
      // 先构造 argv：跨 host / 同 pane / 双 target / sizePercent 越界都在这里拒掉，
      // 避免先打 tmux 再发现参数非法（也保证纯逻辑与路由共用同一份判据）
      const args = buildJoinPaneArgs({ paneId, targetWindowId, targetPaneId, direction, sizePercent })
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
      const sourceSession = await assertTargetAllowed(hostId, tmuxPaneId)
      await assertRequestScopeAllowsSession(request, hostId, sourceSession)
      if (targetPaneId) {
        const target = parsePaneRef(targetPaneId)
        const targetSession = await assertTargetAllowed(hostId, target.tmuxPaneId)
        await assertRequestScopeAllowsSession(request, hostId, targetSession)
      } else if (targetWindowId) {
        const target = parseWindowRef(targetWindowId)
        const { stdout } = await execTmux(hostId, [
          'display-message',
          '-p',
          '-t',
          target.tmuxWindowId,
          '#{session_name}',
        ])
        const sessionName = stdout.trim()
        // 窗口已消失时 tmux 通常直接报错；空值兜底成 404，别把空 session 名喂给 allowlist
        if (!sessionName) throw new PaneTopologyError('TARGET_MISSING', 'Unable to resolve session', 404)
        assertSessionAllowed(sessionName)
        await assertRequestScopeAllowsSession(request, hostId, sessionName)
      }
      await execTmux(hostId, args)
      auditPaneTopology(request, action, auditTarget, 'success', 200, hostId)
      return { ok: true, paneId, hostId }
    } catch (err) {
      return topologyFailure(request, reply, action, auditTarget, err, topologyHostOf(paneId))
    }
  })
  fastify.post('/panes/break', async (request, reply) => {
    const rawBody = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    const action = 'pane-break'
    // break 没有显式目标窗口：审计里用 name 代替 dst，未命名记 new-window
    const rawName = typeof rawBody.name === 'string' && rawBody.name ? rawBody.name : 'new-window'
    const auditTarget = topologyAuditTarget(rawBody.paneId, rawName)
    const parsed = paneBreakBodySchema.safeParse(request.body)
    if (!parsed.success)
      return topologyFailure(
        request,
        reply,
        action,
        auditTarget,
        new PaneTopologyError('INVALID_REQUEST', describeZodError(parsed.error)),
      )
    const { paneId, name } = parsed.data
    try {
      const args = buildBreakPaneArgs({ paneId, name })
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
      // break-pane 只把 pane 独立成新窗口，session 不变；判源 pane 的 session 即可
      const sessionName = await assertTargetAllowed(hostId, tmuxPaneId)
      await assertRequestScopeAllowsSession(request, hostId, sessionName)
      await execTmux(hostId, args)
      auditPaneTopology(request, action, auditTarget, 'success', 200, hostId)
      return { ok: true, paneId, hostId }
    } catch (err) {
      return topologyFailure(request, reply, action, auditTarget, err, topologyHostOf(paneId))
    }
  })
  fastify.post('/panes/swap', async (request, reply) => {
    const rawBody = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    const action = 'pane-swap'
    const auditTarget = topologyAuditTarget(rawBody.paneId, rawBody.targetPaneId)
    const parsed = paneSwapBodySchema.safeParse(request.body)
    if (!parsed.success)
      return topologyFailure(
        request,
        reply,
        action,
        auditTarget,
        new PaneTopologyError('INVALID_REQUEST', describeZodError(parsed.error)),
      )
    const { paneId, targetPaneId } = parsed.data
    try {
      const args = buildSwapPaneArgs({ paneId, targetPaneId })
      const { hostId, tmuxPaneId } = parsePaneRef(paneId)
      const sourceSession = await assertTargetAllowed(hostId, tmuxPaneId)
      await assertRequestScopeAllowsSession(request, hostId, sourceSession)
      const target = parsePaneRef(targetPaneId)
      const targetSession = await assertTargetAllowed(hostId, target.tmuxPaneId)
      await assertRequestScopeAllowsSession(request, hostId, targetSession)
      await execTmux(hostId, args)
      auditPaneTopology(request, action, auditTarget, 'success', 200, hostId)
      return { ok: true, paneId, hostId, targetPaneId }
    } catch (err) {
      return topologyFailure(request, reply, action, auditTarget, err, topologyHostOf(paneId))
    }
  })
}
