import type { FastifyInstance, FastifyReply } from 'fastify'
import { stat } from 'fs/promises'
import { getNormalizedWindowMoves } from '../lib/template-utils.js'
import { assertSessionAllowed, assertTargetAllowed } from '../lib/tmux-policy.js'
import { buildSessionId, parseSessionRef } from '../lib/tmux-target.js'
import { execTmux } from '../lib/tmux-executor.js'
import { normalizeViewId, viewSessionName, viewsEnabled } from '../lib/view-sessions.js'
import { VIEW_SESSION_LIST_FORMAT } from '../lib/session-list.js'
import { recordStreamMetric } from '../lib/perf-metrics.js'
import { getSessionAgentPanes, markAgentPaneSeen } from '../lib/agent-state.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { schedulePeerWindowSync } from '../lib/stream/stream-session.js'
import { findSessionWorkspacePath } from './preferences.js'

// catch 到的值不保证是 Error（tmux/SSH 通道可能抛字符串），统一收窄取文案
function errorMessage(error: unknown, fallback = '') {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * viewId → 已验证归属的 view session 名。
 * - 未开启 views / 没带 viewId / view 尚未创建：null（调用方走 base）
 * - 非法 id：400 Invalid view id
 * - 同名 session 存在但 option 为空/不匹配：404 View session collision
 *
 * 前端 attach 与首屏读是并发的：windows/snapshot/panes 请求常常先于 view session
 * 创建到达。此时必须回退 base，不能 404，否则首屏直接报错。
 */
async function resolveViewSession(hostId: string, baseSession: string, rawViewId: unknown): Promise<string | null> {
  if (!viewsEnabled() || rawViewId === undefined || rawViewId === null) return null
  const viewId = normalizeViewId(rawViewId)
  if (!viewId) throw new Error('Invalid view id')
  const viewName = viewSessionName(hostId, baseSession, viewId)
  let rows: string[]
  try {
    const { stdout } = await execTmux(hostId, ['list-sessions', '-F', VIEW_SESSION_LIST_FORMAT])
    rows = stdout.split(/\r?\n/)
  } catch {
    // 列不出来时按「view 还没建」回退 base；base 查询会以原有语义报真实错误
    return null
  }
  // 名字只用于寻址，归属必须看 option：同名/前缀 session 不能冒充 view。
  const row = rows.find((line) => line.startsWith(`${viewName}\t`))
  if (!row) return null
  const viewBase = row.slice(viewName.length + 1)
  if (viewBase !== baseSession) throw new Error('View session collision')
  return viewName
}

function queryViewId(query: unknown) {
  return (query as { viewId?: unknown } | undefined)?.viewId
}

// 路由错误归位（契约）：解析失败/跨 host 引用属于调用方错误 → 400；tmux 的 can't find ... 与
// 未知 host 属于目标不存在 → 404。这两类以前会被 fastify 兜成 500 并回 tmux 英文原文。
// 其它错误保持 500，但换成结构化 {message, code}，message 里仍带 tmux 原文。
const MISSING_TARGET = /can't find (session|window|pane)|no such (session|window|pane)|unknown (session|window|pane)/i
const INVALID_REQUEST_MESSAGE =
  /^(Invalid |Window does not belong to host|Pane does not belong to host|Session is not allowed|orderedWindowIds is required)/
// targetKind：tmux-policy 的 'Unable to resolve session' 只说「目标解析不到」，具体是 window 还是
// pane 由端点自己知道，用它把 404 code 归到正确的资源名
function classifiedErrorReply(
  reply: FastifyReply,
  error: unknown,
  targetKind: 'session' | 'window' | 'pane' = 'session',
) {
  const message = errorMessage(error, 'Request failed')
  const missing = MISSING_TARGET.exec(message)?.[1]?.toLowerCase()
  if (missing) return reply.code(404).send({ message, code: `${missing.toUpperCase()}_NOT_FOUND` })
  // view 名被同名普通 session 占用（option 为空/不匹配）属 collision，不猜归属
  if (message === 'View session collision') return reply.code(404).send({ message, code: 'VIEW_CONFLICT' })
  // 'Unable to resolve …'（tmux-policy 解析目标失败）、'no current target'（-t 目标已不存在）、
  // 'no server running…'（server 整体没起，session 自然不存在）都归 404，具体资源名用端点给的 hint
  if (
    /^Unable to resolve|^no current (?:target|session|window|pane)|^no server running|error connecting to .*server/i.test(
      message,
    )
  )
    return reply.code(404).send({ message, code: `${targetKind.toUpperCase()}_NOT_FOUND` })
  if (/^Host ".+" not found$/.test(message)) return reply.code(404).send({ message, code: 'HOST_NOT_FOUND' })
  if (INVALID_REQUEST_MESSAGE.test(message)) return reply.code(400).send({ message, code: 'INVALID_REQUEST' })
  return null
}
// 硬失败端点用：分类不上的一律 500 结构化，不再裸抛
function failRoute(reply: FastifyReply, error: unknown, targetKind: 'session' | 'window' | 'pane' = 'session') {
  return (
    classifiedErrorReply(reply, error, targetKind) ??
    reply.code(500).send({ message: errorMessage(error, 'Request failed'), code: 'TMUX_ERROR' })
  )
}

// TMUXGO_AGENT_SNAPSHOT_SEEN：快照请求是否顺带清 done。默认开（=1），
// 只有显式 0/"0"/false 才关；关闭时机归 S3（旧客户端下线后 GET 变纯读）
function snapshotSeenEnabled() {
  const raw = process.env.TMUXGO_AGENT_SNAPSHOT_SEEN?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

function parseSessionName(hostId: string, sessionRef: string) {
  return parseSessionRef(hostId, sessionRef).sessionName
}
// queryName 是 tmux 查询目标（view 时是 view session），baseName 是业务身份：
// scope、buildSessionId、响应 sessionId 都必须用 base，view 名不能漏进业务层。
async function getTmuxWindows(hostId: string, baseName: string, queryName: string = baseName) {
  assertSessionAllowed(baseName)
  const { stdout } = await execTmux(hostId, [
    'list-windows',
    '-t',
    queryName,
    '-F',
    '#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}',
  ])
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, index, name, active, zoomed] = line.split('|')
      return {
        id: `${hostId}:${id}`,
        tmuxWindowId: id,
        sessionId: buildSessionId(hostId, baseName),
        index: parseInt(index, 10),
        name,
        active: active === '1',
        zoomed: zoomed === '1',
      }
    })
}
// grouped session 下裸 `select-window -t @n` 归属有歧义（tmux 可能落到 view 上）。
// 先按 base 列出真实 window（`base:@n` 这种限定 target 在 @n 不存在时会退回当前窗口，
// 不能用来验归属），拿到 index 后再 `<session>:<index>` 精确切。
async function getTmuxWindowIndex(hostId: string, baseName: string, tmuxWindowId: string) {
  const { stdout } = await execTmux(hostId, ['list-windows', '-t', baseName, '-F', '#{window_id}\t#{window_index}'])
  for (const line of stdout.split(/\r?\n/)) {
    const [id, index] = line.split('\t')
    if (id === tmuxWindowId && /^\d+$/.test(index)) return index
  }
  throw new Error(`Can't find window: ${tmuxWindowId}`)
}
async function normalizeWindowOrder(hostId: string, sessionName: string, orderedWindowIds: string[]) {
  assertSessionAllowed(sessionName)
  const tmuxOrderedIds = orderedWindowIds.map((item) => {
    if (!item.startsWith(`${hostId}:`)) throw new Error('Window does not belong to host')
    return item.slice(hostId.length + 1)
  })
  for (const move of getNormalizedWindowMoves(sessionName, tmuxOrderedIds)) {
    await assertTargetAllowed(hostId, move.source, sessionName)
    await execTmux(hostId, ['move-window', '-s', move.source, '-t', move.target])
  }
}
async function getTmuxPanes(hostId: string, sessionName: string, windowIndex: number) {
  assertSessionAllowed(sessionName)
  const [{ stdout }, agentPanes] = await Promise.all([
    execTmux(hostId, [
      'list-panes',
      '-t',
      `${sessionName}:${windowIndex}`,
      '-F',
      '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{@tmuxgo_task}',
    ]),
    Promise.resolve(agentMonitor.getSessionStates(hostId, sessionName) || getSessionAgentPanes(hostId, sessionName)),
  ])
  const agentByPane = new Map(agentPanes.map((pane) => [pane.paneId, pane]))
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, windowId, index, title, active, width, height, left, top, task] = line.split('|')
      const paneId = `${hostId}:${id}`
      const agentState = agentByPane.get(paneId)
      return {
        id: paneId,
        tmuxPaneId: id,
        windowId: `${hostId}:${windowId}`,
        index: parseInt(index, 10),
        title: title || 'shell',
        active: active === '1',
        left: parseInt(left, 10) || 0,
        top: parseInt(top, 10) || 0,
        size: {
          cols: parseInt(width, 10) || 80,
          rows: parseInt(height, 10) || 24,
        },
        // 任务号是冷元数据（用户/工具写进 pane user-option），空即未绑定
        ...(task ? { task } : {}),
        ...(agentState
          ? {
              agent: agentState.agent,
              agentSessionId: agentState.agentSessionId,
              agentStatus: agentState.agentStatus,
              phase: agentState.phase,
              lastEvent: agentState.lastEvent,
              source: agentState.source,
              confidence: agentState.confidence,
              since: agentState.since,
              updatedAt: agentState.updatedAt,
              eventId: agentState.eventId,
              message: agentState.message,
              revision: agentState.revision,
            }
          : {}),
      }
    })
}
// baseName 同时是 scope 与 agent 状态的查询键；queryName 只用于 tmux 列 pane。
// agent 状态按 base 记录，传 view 名会查空（view 只是同一组 window 的另一个视角）。
async function getTmuxSessionPanes(hostId: string, baseName: string, queryName: string = baseName) {
  assertSessionAllowed(baseName)
  const [{ stdout }, agentPanes] = await Promise.all([
    execTmux(hostId, [
      'list-panes',
      '-s',
      '-t',
      queryName,
      '-F',
      // window_index 给前端做 window → pane 的稳定排序：list-panes -s 本身按 window 顺序输出，
      // 但没有编号，前端无法在合并多份冷数据后还原树形层级
      '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{window_name}|#{window_index}|#{@tmuxgo_task}',
    ]),
    Promise.resolve(agentMonitor.getSessionStates(hostId, baseName) || getSessionAgentPanes(hostId, baseName)),
  ])
  const agentByPane = new Map(agentPanes.map((pane) => [pane.paneId, pane]))
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'))
    .map(([id, windowId, index, title, active, width, height, left, top, windowName, windowIndexText, task]) => {
      const paneId = `${hostId}:${id}`
      const agentState = agentByPane.get(paneId)
      return {
        id: paneId,
        tmuxPaneId: id,
        windowId: `${hostId}:${windowId}`,
        index: parseInt(index, 10),
        title: title || 'shell',
        active: active === '1',
        left: parseInt(left, 10) || 0,
        top: parseInt(top, 10) || 0,
        size: { cols: parseInt(width, 10) || 80, rows: parseInt(height, 10) || 24 },
        windowName,
        windowIndex: parseInt(windowIndexText, 10),
        ...(task ? { task } : {}),
        ...(agentState
          ? {
              agent: agentState.agent,
              agentSessionId: agentState.agentSessionId,
              agentStatus: agentState.agentStatus,
              phase: agentState.phase,
              lastEvent: agentState.lastEvent,
              source: agentState.source,
              confidence: agentState.confidence,
              since: agentState.since,
              updatedAt: agentState.updatedAt,
              eventId: agentState.eventId,
              message: agentState.message,
              revision: agentState.revision,
            }
          : {}),
      }
    })
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
  fastify.get('/hosts/:hostId/sessions/:sessionId/windows', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const viewName = await resolveViewSession(hostId, sessionName, queryViewId(request.query))
      return await getTmuxWindows(hostId, sessionName, viewName || sessionName)
    } catch (err) {
      return failRoute(reply, err)
    }
  })
  fastify.get('/windows/:windowId/panes', async (request, reply) => {
    const { windowId } = request.params as { windowId: string }
    try {
      const { hostId, windowName } = parseWindowRouteParam(windowId)
      const { stdout } = await execTmux(hostId, [
        'display-message',
        '-p',
        '-t',
        windowName,
        '#{session_name}|#{window_index}',
      ])
      const [sessionName, windowIndexText] = stdout.trim().split('|')
      const windowIndex = parseInt(windowIndexText, 10)
      if (!sessionName || !Number.isFinite(windowIndex)) return []
      return await getTmuxPanes(hostId, sessionName, windowIndex)
    } catch (err) {
      return failRoute(reply, err, 'window')
    }
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/panes', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const viewName = await resolveViewSession(hostId, sessionName, queryViewId(request.query))
      return await getTmuxSessionPanes(hostId, sessionName, viewName || sessionName)
    } catch (err) {
      return failRoute(reply, err)
    }
  })
  fastify.get('/hosts/:hostId/sessions/:sessionId/snapshot', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const viewName = await resolveViewSession(hostId, sessionName, queryViewId(request.query))
      recordStreamMetric('snapshotRequests')
      const [windows, panes] = await Promise.all([
        getTmuxWindows(hostId, sessionName, viewName || sessionName),
        getTmuxSessionPanes(hostId, sessionName, viewName || sessionName),
      ])
      const activeWindow = windows.find((window) => window.active) || windows[0] || null
      const activePane =
        panes.find((pane) => pane.windowId === activeWindow?.id && pane.active) ||
        panes.find((pane) => pane.windowId === activeWindow?.id) ||
        null
      // 快照请求顺带清 done：老前端不发 agent_seen，靠这条边读边写的"搭便车"消徽标。
      // 新前端有显式 agent_seen 后两条路双清同一个 done 无害，所以默认保持 1；
      // 待旧客户端消亡再翻 0（S3），届时快照变成纯读，GET 不再有写副作用
      if (activePane && snapshotSeenEnabled()) {
        const seen = agentMonitor.markSeen(activePane.id) || markAgentPaneSeen(activePane.id)
        if (seen)
          Object.assign(activePane, {
            agent: seen.agent,
            agentSessionId: seen.agentSessionId,
            agentStatus: seen.agentStatus,
            phase: seen.phase,
            lastEvent: seen.lastEvent,
            source: seen.source,
            confidence: seen.confidence,
            since: seen.since,
            updatedAt: seen.updatedAt,
            eventId: seen.eventId,
            message: seen.message,
            revision: seen.revision,
          })
      }
      return {
        sessionId: buildSessionId(hostId, sessionName),
        sessionName,
        windows,
        panes,
        activeWindowId: activeWindow?.id || null,
        activePaneId: activePane?.id || null,
      }
    } catch (err) {
      return failRoute(reply, err)
    }
  })
  fastify.get('/panes/:paneId/output', async (request, reply) => {
    const { paneId } = request.params as { paneId: string }
    try {
      const sep = paneId.indexOf(':')
      if (sep <= 0 || sep === paneId.length - 1) throw new Error('Invalid pane id')
      const hostId = paneId.slice(0, sep)
      const tmuxPaneId = await parsePaneTarget(hostId, paneId)
      await assertTargetAllowed(hostId, tmuxPaneId)
      const { stdout } = await execTmux(hostId, ['capture-pane', '-pt', tmuxPaneId, '-p'])
      return { paneId, tmuxPaneId, data: stdout }
    } catch (err) {
      return failRoute(reply, err, 'pane')
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { name } = request.body as { name: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      assertSessionAllowed(sessionName)
      // -c 落点优先级：session 绑定的工作区路径 > 活动 pane cwd；
      // 本地绑定失效（目录已删）时退回 pane cwd，远端路径无法本机校验按原样透传
      const boundCwd = await findSessionWorkspacePath(hostId, sessionId).catch(() => '')
      const cwd =
        hostId === 'local' && boundCwd
          ? await stat(boundCwd)
              .then((info) => (info.isDirectory() ? boundCwd : ''))
              .catch(() => '')
          : boundCwd
      const { stdout } = await execTmux(hostId, [
        'new-window',
        '-P',
        '-F',
        '#{window_id}',
        '-t',
        sessionName,
        '-n',
        name || 'new-window',
        '-c',
        cwd || '#{pane_current_path}',
      ])
      const createdWindowId = stdout.trim()
      const windows = await getTmuxWindows(hostId, sessionName)
      return (
        windows.find((window) => window.tmuxWindowId === createdWindowId) || windows.find((window) => window.active)
      )
    } catch (err) {
      return failRoute(reply, err)
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/select', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId, viewId } = request.body as { windowId: string; viewId?: unknown }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const tmuxWindowId = parseWindowRef(hostId, windowId)
      assertSessionAllowed(sessionName)
      const viewName = await resolveViewSession(hostId, sessionName, viewId)
      // 用 base 限定的 target 校验归属：裸 @n 在 grouped session 下可能解析到 view。
      await assertTargetAllowed(hostId, `${sessionName}:${tmuxWindowId}`, sessionName)
      const windowIndex = await getTmuxWindowIndex(hostId, sessionName, tmuxWindowId)
      const targetSession = viewName || sessionName
      await execTmux(hostId, ['select-window', '-t', `${targetSession}:${windowIndex}`])
      // 各 window 尺寸独立：切换当前 window 后附着的 client 视图可能与
      // window 尺寸发散，调度一次同 session 仲裁把所有附着同步过去。
      // view 的 current window 属于 view session，同步键也必须用 view。
      schedulePeerWindowSync(hostId, targetSession)
      const windows = await getTmuxWindows(hostId, sessionName, targetSession)
      return { ok: true, windows }
    } catch (err) {
      return classifiedErrorReply(reply, err, 'window') ?? { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/rename', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId, name } = request.body as { windowId: string; name: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const tmuxWindowId = parseWindowRef(hostId, windowId)
      assertSessionAllowed(sessionName)
      await assertTargetAllowed(hostId, tmuxWindowId, sessionName)
      await execTmux(hostId, ['rename-window', '-t', tmuxWindowId, name])
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err) {
      return classifiedErrorReply(reply, err, 'window') ?? { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/move', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { orderedWindowIds } = request.body as { orderedWindowIds?: string[] }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      assertSessionAllowed(sessionName)
      if (!orderedWindowIds?.length) throw new Error('orderedWindowIds is required')
      await normalizeWindowOrder(hostId, sessionName, orderedWindowIds)
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err) {
      return classifiedErrorReply(reply, err, 'window') ?? { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/hosts/:hostId/sessions/:sessionId/windows/kill', async (request, reply) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const { windowId } = request.body as { windowId: string }
    try {
      const sessionName = parseSessionName(hostId, sessionId)
      const tmuxWindowId = parseWindowRef(hostId, windowId)
      assertSessionAllowed(sessionName)
      await assertTargetAllowed(hostId, tmuxWindowId, sessionName)
      await execTmux(hostId, ['kill-window', '-t', tmuxWindowId])
      const windows = await getTmuxWindows(hostId, sessionName)
      return { ok: true, windows }
    } catch (err) {
      return classifiedErrorReply(reply, err, 'window') ?? { ok: false, error: errorMessage(err) }
    }
  })
  fastify.post('/windows/:windowId/panes', async (request, reply) => {
    const { windowId } = request.params as { windowId: string }
    const { direction } = request.body as { direction: 'horizontal' | 'vertical' }
    try {
      const { hostId, windowName } = parseWindowRouteParam(windowId)
      const { stdout } = await execTmux(hostId, [
        'display-message',
        '-p',
        '-t',
        windowName,
        '#{session_name}|#{window_index}',
      ])
      const [sessionName, windowIndexText] = stdout.trim().split('|')
      const windowIndex = parseInt(windowIndexText, 10)
      if (!sessionName || !Number.isFinite(windowIndex)) throw new Error('Invalid window target')
      assertSessionAllowed(sessionName)
      const flag = direction === 'horizontal' ? '-h' : '-v'
      await execTmux(hostId, [
        'split-window',
        '-c',
        '#{pane_current_path}',
        '-t',
        `${sessionName}:${windowIndex}`,
        flag,
      ])
      const panes = await getTmuxPanes(hostId, sessionName, windowIndex)
      return panes[panes.length - 1]
    } catch (err) {
      return failRoute(reply, err, 'window')
    }
  })
}
