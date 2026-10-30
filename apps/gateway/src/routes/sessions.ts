import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import path from 'path'
import { stat } from 'fs/promises'
import type { SessionTemplateLayout } from '../lib/template-utils.js'
import { getHostById } from '../lib/hosts.js'
import { resolvePrincipalScope, scopeAllowsSession } from '../lib/access-scope.js'
import { getRequestPrincipal } from '../lib/principal.js'
import { LayoutStringError, assertLayoutPaneCount, validateLayoutString } from '../lib/layout-string.js'
import {
  applyCreatedSessionDefaults,
  assertSessionAllowed,
  isValidSessionName,
  prepareSessionAttach,
  raiseServerHistoryLimit,
} from '../lib/tmux-policy.js'
import { buildSessionId, parseSessionRef } from '../lib/tmux-target.js'
import { execTmux, execHostShell } from '../lib/tmux-executor.js'
import {
  applyTemplateLayout,
  buildSessionCreateArgs,
  getFirstPaneIndex,
  getFirstWindowTarget,
  getPaneStartupCommand,
  quoteShellValue,
  runSendKeys,
} from '../lib/session-layout-apply.js'
import { getHostAgentPanes, summarizeAgentPanes } from '../lib/agent-state.js'
import { probeWithCooldown } from '../lib/host-probe-cooldown.js'
import { agentMonitor } from '../lib/agent-monitor.js'
import { emitPluginEvent } from '../lib/plugin-manager.js'
import {
  describeZodError,
  hostParamsSchema,
  sessionCreateBodySchema,
  sessionLayoutApplyBodySchema,
  sessionRenameBodySchema,
} from '../lib/request-validation.js'
import {
  buildSessionLayoutDocument,
  normalizeSessionLayoutDocument,
  sessionLayoutToTemplateLayout,
  type SessionLayoutPaneRow,
} from '../lib/session-layout.js'

// catch 到的值不保证是 Error（tmux/SSH 通道可能抛字符串），统一收窄取文案
function errorMessage(error: unknown, fallback = '') {
  return error instanceof Error && error.message ? error.message : fallback
}

// tmux kill-session 的 -t 非精确匹配：目标 session 不存在时回退为前缀/fnmatch
// 模式匹配并杀掉全部命中项（删已死 session 会误杀同名前缀的所有会话）。
// '=' 前缀强制精确匹配。
const exactSessionTarget = (sessionName: string) => `=${sessionName}`
const batchDeleteLimitDefault = 1000
const batchDeleteLimitMax = 5000
const thumbnailCaptureConcurrency = 3
const emptySessionErrorMarkers = ['no server running', 'failed to connect to server', 'no sessions']
type BatchDeleteMode = 'preview' | 'execute'
interface HostTmuxSession {
  id: string
  hostId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
  attached: boolean
}
interface BatchDeleteFilters {
  createdBefore?: string
  inactiveBefore?: string
  nameIncludes?: string
  includeAttached?: boolean
}
interface BatchDeleteRequest {
  mode?: BatchDeleteMode
  sessionIds?: string[]
  filters?: BatchDeleteFilters
  limit?: number
  force?: boolean
}
interface BatchDeleteSkip {
  sessionId: string
  name: string
  reason: string
}
interface BatchDeleteTarget {
  sessionId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
  attached: boolean
}
interface SessionThumbnailPane {
  id: string
  title: string
  active: boolean
  left: number
  top: number
  size: { cols: number; rows: number }
  data: string
  // pane user-option 里的任务号；未绑定则不带该字段
  task?: string
}
interface SessionThumbnail {
  id: string
  name: string
  window: { id: string; index: number; name: string; zoomed: boolean } | null
  panes: SessionThumbnailPane[]
}
function normalizeSessionName(hostId: string, sessionRef: string) {
  return parseSessionRef(hostId, sessionRef).sessionName
}
function parseOptionalDate(value: string | undefined, fieldName: string) {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${fieldName}`)
  return timestamp
}
function normalizeBatchLimit(limit: number | undefined) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return batchDeleteLimitDefault
  return Math.max(1, Math.min(batchDeleteLimitMax, Math.floor(limit)))
}
function hasBatchDeleteFilter(filters: BatchDeleteFilters | undefined) {
  if (!filters) return false
  if (filters.createdBefore) return true
  if (filters.inactiveBefore) return true
  if (typeof filters.nameIncludes === 'string' && filters.nameIncludes.trim()) return true
  if (filters.includeAttached === true) return true
  return false
}
function toBatchDeleteTarget(session: HostTmuxSession): BatchDeleteTarget {
  return {
    sessionId: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    windowCount: session.windowCount,
    attached: session.attached,
  }
}
// listHostTmuxSessions 内部已把「空 socket/无 session」归一成返回 []，
// 能抛出的都是真失败，全部进冷却（含 Host not found 这类配置级错误）
async function getHostTmuxSessions(hostId: string): Promise<HostTmuxSession[]> {
  return probeWithCooldown(hostId, () => listHostTmuxSessions(hostId))
}
async function listHostTmuxSessions(hostId: string): Promise<HostTmuxSession[]> {
  try {
    const { stdout } = await execTmux(hostId, [
      'list-sessions',
      '-F',
      '#{session_id}|#{session_name}|#{session_windows}|#{session_created}|#{session_activity}|#{session_attached}',
    ])
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const [, name] = line.split('|')
        try {
          assertSessionAllowed(name)
          return true
        } catch {
          return false
        }
      })
      .map((line) => {
        const [, name, windows, created, activity, attached] = line.split('|')
        const createdAtUnix = parseInt(created, 10)
        const activityUnix = parseInt(activity, 10)
        const attachedCount = parseInt(attached, 10)
        const createdAt = Number.isFinite(createdAtUnix)
          ? new Date(createdAtUnix * 1000).toISOString()
          : new Date().toISOString()
        const lastActiveAt = Number.isFinite(activityUnix) ? new Date(activityUnix * 1000).toISOString() : createdAt
        return {
          id: buildSessionId(hostId, name),
          hostId,
          name,
          createdAt,
          lastActiveAt,
          windowCount: parseInt(windows, 10),
          attached: Number.isFinite(attachedCount) && attachedCount > 0,
        }
      })
  } catch (err) {
    const message = errorMessage(err).toLowerCase()
    if (
      // socket 文件已删（server 刚 exit-empty）时报 "error connecting to
      // <socket> (No such file or directory)"，socket 路径不固定（隔离测试
      // 用自定义 TMUX_TMPDIR），只按错误语义判定不等具体路径
      emptySessionErrorMarkers.some((marker) => message.includes(marker)) ||
      (message.includes('error connecting to') && message.includes('no such file or directory'))
    )
      return []
    console.error('Failed to list tmux sessions:', err)
    throw err
  }
}
async function getSessionThumbnails(hostId: string): Promise<SessionThumbnail[]> {
  const sessions = await getHostTmuxSessions(hostId)
  if (!sessions.length) return []
  const sessionByName = new Map(sessions.map((session) => [session.name, session]))
  const { stdout } = await execTmux(hostId, [
    'list-panes',
    '-a',
    '-F',
    '#{session_name}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}|#{pane_id}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{@tmuxgo_task}',
  ])
  const thumbnails = new Map<string, SessionThumbnail>()
  for (const session of sessions)
    thumbnails.set(session.name, { id: session.id, name: session.name, window: null, panes: [] })
  const captures: { pane: SessionThumbnailPane; target: string }[] = []
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [
      sessionName,
      windowId,
      windowIndex,
      windowName,
      windowActive,
      windowZoomed,
      paneId,
      title,
      paneActive,
      width,
      height,
      left,
      top,
      task,
    ] = line.split('|')
    if (windowActive !== '1' || !sessionByName.has(sessionName)) continue
    const thumbnail = thumbnails.get(sessionName)
    if (!thumbnail) continue
    if (!thumbnail.window)
      thumbnail.window = {
        id: `${hostId}:${windowId}`,
        index: parseInt(windowIndex, 10) || 0,
        name: windowName,
        zoomed: windowZoomed === '1',
      }
    const pane = {
      id: `${hostId}:${paneId}`,
      title: title || 'shell',
      active: paneActive === '1',
      left: parseInt(left, 10) || 0,
      top: parseInt(top, 10) || 0,
      size: { cols: parseInt(width, 10) || 80, rows: parseInt(height, 10) || 24 },
      data: '',
      ...(task ? { task } : {}),
    }
    thumbnail.panes.push(pane)
    captures.push({ pane, target: paneId })
  }
  let captureIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(thumbnailCaptureConcurrency, captures.length) }, async () => {
      while (captureIndex < captures.length) {
        const { pane, target } = captures[captureIndex++]
        try {
          const { stdout: data } = await execTmux(hostId, ['capture-pane', '-pt', target, '-p'])
          pane.data = data
        } catch {}
      }
    }),
  )
  return sessions.map((session) => thumbnails.get(session.name)!).filter((thumbnail) => !!thumbnail.window)
}
function getBatchDeleteSelection(hostId: string, sessions: HostTmuxSession[], body: BatchDeleteRequest) {
  const filters = body.filters
  const includeAttached = filters?.includeAttached === true
  const createdBeforeTs = parseOptionalDate(filters?.createdBefore, 'filters.createdBefore')
  const inactiveBeforeTs = parseOptionalDate(filters?.inactiveBefore, 'filters.inactiveBefore')
  const nameIncludes = typeof filters?.nameIncludes === 'string' ? filters.nameIncludes.trim().toLowerCase() : ''
  const selectedSessionNames = new Set<string>()
  if (Array.isArray(body.sessionIds)) {
    for (const sessionId of body.sessionIds) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) continue
      selectedSessionNames.add(normalizeSessionName(hostId, sessionId.trim()))
    }
  }
  if (!selectedSessionNames.size && !hasBatchDeleteFilter(filters)) throw new Error('sessionIds or filters is required')
  let matched = sessions
  if (selectedSessionNames.size) matched = matched.filter((session) => selectedSessionNames.has(session.name))
  if (nameIncludes) matched = matched.filter((session) => session.name.toLowerCase().includes(nameIncludes))
  if (createdBeforeTs !== null) matched = matched.filter((session) => Date.parse(session.createdAt) < createdBeforeTs)
  if (inactiveBeforeTs !== null)
    matched = matched.filter((session) => Date.parse(session.lastActiveAt) < inactiveBeforeTs)
  const skipped: BatchDeleteSkip[] = []
  if (selectedSessionNames.size) {
    const existingNames = new Set(sessions.map((session) => session.name))
    for (const sessionName of selectedSessionNames) {
      if (!existingNames.has(sessionName))
        skipped.push({ sessionId: buildSessionId(hostId, sessionName), name: sessionName, reason: 'not_found' })
    }
  }
  const eligible: HostTmuxSession[] = []
  for (const session of matched) {
    if (session.attached && !includeAttached) {
      skipped.push({ sessionId: session.id, name: session.name, reason: 'attached' })
      continue
    }
    eligible.push(session)
  }
  return { matched, eligible, skipped }
}
// 追加模式应用 layout：所有窗口新建，绝不触碰已有窗口/pane；
// new-window/split-window 均带 -d 不抢焦点，结束还原活动窗口
async function applySessionLayoutAppend(hostId: string, sessionName: string, layout: SessionTemplateLayout) {
  assertSessionAllowed(sessionName)
  if (!layout.windows.length) return
  const activeWindowTarget = await getFirstWindowTarget(hostId, sessionName)
  for (const windowDef of layout.windows) {
    const panes = windowDef.panes?.length ? windowDef.panes : [{}]
    if (!windowDef.name) throw new Error('Layout apply failed: window missing name')
    const splitFlag = windowDef.splitDirection === 'vertical' ? '-v' : '-h'
    const layoutPreset = windowDef.layoutPreset || 'tiled'
    const args = ['new-window', '-d', '-P', '-F', '#{window_index}', '-t', sessionName, '-n', windowDef.name]
    if (panes[0]?.cwd?.trim()) args.push('-c', panes[0].cwd.trim())
    const { stdout } = await execTmux(hostId, args)
    const windowIndex = stdout.trim()
    if (!windowIndex) throw new Error('Layout apply failed: new-window returned no index')
    const windowTarget = `${sessionName}:${windowIndex}`
    const paneBaseIndex = await getFirstPaneIndex(hostId, windowTarget)
    for (let p = 1; p < panes.length; p++) {
      await execTmux(hostId, [
        'split-window',
        '-d',
        '-c',
        panes[p]?.cwd?.trim() || '#{pane_current_path}',
        '-t',
        windowTarget,
        splitFlag,
      ])
    }
    await execTmux(hostId, ['select-layout', '-t', windowTarget, layoutPreset])
    for (let p = 0; p < panes.length; p++) {
      const command = getPaneStartupCommand(panes[p] || {})
      if (!command) continue
      await runSendKeys(hostId, `${windowTarget}.${paneBaseIndex + p}`, command)
    }
  }
  await execTmux(hostId, ['select-window', '-t', activeWindowTarget])
}
// layout 内所有非空 cwd 必须在目标 host 存在且为绝对路径；远端经 execHostShell 探测
async function assertLayoutCwdsExist(hostId: string, layout: SessionTemplateLayout) {
  const cwds = [
    ...new Set(
      layout.windows.flatMap((window) => window.panes.map((pane) => pane.cwd?.trim()).filter(Boolean) as string[]),
    ),
  ]
  for (const cwd of cwds) {
    if (!path.isAbsolute(cwd)) throw new Error(`Invalid session layout: cwd must be absolute: ${cwd}`)
    await assertCwdExists(hostId, cwd)
  }
}
async function cleanupSession(hostId: string, sessionName: string) {
  try {
    await execTmux(hostId, ['kill-session', '-t', exactSessionTarget(sessionName)])
  } catch {}
}
async function assertCwdExists(hostId: string, cwd: string) {
  if (hostId === 'local') {
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
      return
    } catch {
      throw new Error(`cwd directory does not exist: ${cwd}`)
    }
  }
  let exists = false
  try {
    const result = await execHostShell(hostId, `test -d ${quoteShellValue(cwd)} && echo tmuxgo-cwd-ok`)
    exists = result.stdout.includes('tmuxgo-cwd-ok')
  } catch (err) {
    const message = String((err as Error)?.message || '')
    if (message.includes('SSH') || message.includes('Host key')) throw err
  }
  if (!exists) throw new Error(`cwd directory does not exist on host: ${cwd}`)
}

// ── 原生 layout string（#{window_layout}）────────────────────────────────────
// 把 tmux 的布局串当字符串读取/套用：只改目标窗口的几何尺寸，不新建也不删除 pane。
// 这类端点要区分「调用方传错」和「目标不存在」，所以用带状态码的本地错误承载，
// 在 handler 里统一映射成 { ok:false, code, message }。
class LayoutRouteError extends Error {
  readonly statusCode: number
  readonly code: string
  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'LayoutRouteError'
    this.statusCode = statusCode
    this.code = code
  }
}
const layoutWindowIdPattern = /^@\d+$/

// hostId 走与既有路由同一个 zod 参数校验；失败时自己出 400，别落到全局 handler 兜成 500
function layoutHostId(params: unknown) {
  const parsed = hostParamsSchema.safeParse(params)
  if (!parsed.success) throw new LayoutRouteError(400, 'INVALID_REQUEST', describeZodError(parsed.error))
  return parsed.data.hostId
}

function sendLayoutError(reply: FastifyReply, error: unknown) {
  if (error instanceof LayoutRouteError)
    return reply.code(error.statusCode).send({ ok: false, code: error.code, message: error.message })
  if (error instanceof LayoutStringError)
    return reply.code(400).send({ ok: false, code: error.code, message: error.message })
  // tmux 在我们校验之后仍拒绝（如串合法但几何不可用）：结构化 502，不裸抛
  return reply
    .code(502)
    .send({ ok: false, code: 'LAYOUT_TMUX_FAILED', message: errorMessage(error, 'Layout request failed') })
}

// host 不存在直接 404，避免把「拼错 hostId」混进 tmux 报错
async function assertLayoutHost(hostId: string) {
  if (!(await getHostById(hostId))) throw new LayoutRouteError(404, 'HOST_NOT_FOUND', `Host "${hostId}" not found`)
}

// sessionId → 真实 session 名，并做 allowlist 校验（与既有 /layout 路由同一套策略）
function layoutSessionName(hostId: string, sessionId: string) {
  let sessionName: string
  try {
    sessionName = normalizeSessionName(hostId, sessionId)
  } catch (err) {
    throw new LayoutRouteError(400, 'INVALID_SESSION', errorMessage(err, 'Invalid session id'))
  }
  try {
    assertSessionAllowed(sessionName)
  } catch (err) {
    const message = errorMessage(err, 'Session is not allowed')
    const forbidden = /not allowed/i.test(message)
    throw new LayoutRouteError(forbidden ? 403 : 400, forbidden ? 'SESSION_NOT_ALLOWED' : 'INVALID_SESSION', message)
  }
  return sessionName
}

// 请求级 scope：全局 accessScopeGuard 只能看到路径里的 host，session 维度要等
// sessionId 解析成真名后才能判定。这一步是 layout-string 的写/读入口唯一的 session
// 级拦截，缺了它受限身份（share ticket / 受限 token）就能对 scope 外 session 读布局、
// 甚至把布局套过去改它的几何。写法与 panes.ts 的拓扑端保持一致。
function assertRequestScopeAllowsSession(request: FastifyRequest, hostId: string, sessionName: string) {
  const scope = resolvePrincipalScope(getRequestPrincipal(request))
  if (scope && !scopeAllowsSession(scope, hostId, sessionName))
    throw new LayoutRouteError(403, 'SESSION_NOT_ALLOWED', 'Session is not allowed')
}

// 取 session 下的窗口清单；顺带确认 session 真实存在（list-windows 失败 = 目标没了）
async function listLayoutWindows(hostId: string, sessionName: string) {
  let stdout: string
  try {
    const result = await execTmux(hostId, [
      'list-windows',
      '-t',
      exactSessionTarget(sessionName),
      '-F',
      '#{window_id}|#{window_active}',
    ])
    stdout = result.stdout
  } catch (err) {
    throw new LayoutRouteError(404, 'SESSION_NOT_FOUND', errorMessage(err, `Session not found: ${sessionName}`))
  }
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowId, active] = line.split('|')
      return { windowId, active: active === '1' }
    })
}

// 解析目标窗口：显式 windowId 必须在 session 里（不在 → 404），缺省取 active window
async function resolveLayoutWindow(hostId: string, sessionName: string, windowId: string | undefined) {
  const windows = await listLayoutWindows(hostId, sessionName)
  if (!windows.length) throw new LayoutRouteError(404, 'SESSION_NOT_FOUND', `Session not found: ${sessionName}`)
  if (windowId && !windows.some((window) => window.windowId === windowId))
    throw new LayoutRouteError(404, 'WINDOW_NOT_FOUND', `Window ${windowId} not found in session ${sessionName}`)
  const target = windowId ?? windows.find((window) => window.active)?.windowId
  if (!target) throw new LayoutRouteError(404, 'WINDOW_NOT_FOUND', `Session ${sessionName} has no active window`)
  return target
}

// 窗口里的实际 pane 数（layout string 的叶子数必须与它一致）
async function countWindowPanes(hostId: string, windowId: string) {
  const { stdout } = await execTmux(hostId, ['list-panes', '-t', windowId, '-F', '#{pane_id}'])
  return stdout.trim().split('\n').filter(Boolean).length
}

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = request.params as { hostId: string }
    // agents=0：客户端已订阅 WS 推送（agent_state 帧会写同一个缓存），REST 不必再算一遍
    // agents/summary——省的是每次轮询的 filter+summarize 与 payload，不是频次。
    // 缺省（含老客户端）行为完全不变：照旧返回 agents 与 agentSummary
    const includeAgents = (request.query as { agents?: string } | undefined)?.agents !== '0'
    const sessions = await getHostTmuxSessions(hostId)
    if (!sessions.length) return []
    if (!includeAgents) return sessions
    const agentPanes =
      agentMonitor.getStates(hostId) ||
      (await getHostAgentPanes(
        hostId,
        sessions.map((session) => session.name),
      ).catch(() => []))
    return sessions.map((session) => {
      const agents = agentPanes.filter((pane) => pane.sessionName === session.name)
      return { ...session, agents, agentSummary: summarizeAgentPanes(agents) }
    })
  })
  fastify.get('/hosts/:hostId/session-thumbnails', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return { sessions: await getSessionThumbnails(hostId) }
  })
  fastify.post('/hosts/:hostId/sessions', async (request) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const { name, layout, cwd } = sessionCreateBodySchema.parse(request.body) as {
      name: string
      layout?: SessionTemplateLayout
      cwd?: string
    }
    if (!isValidSessionName(name)) throw new Error('Invalid session name')
    const normalizedCwd = cwd && cwd.trim() && path.isAbsolute(cwd.trim()) ? cwd.trim() : undefined
    try {
      const existingSessions = await getHostTmuxSessions(hostId)
      const existingSession = existingSessions.find((s) => s.name === name)
      if (existingSession) {
        await prepareSessionAttach(hostId, existingSession.name)
        // existed 标记给前端区分"命中已有会话"与"真新建"，避免误报"已创建"
        return { ...existingSession, cwd: normalizedCwd, existed: true }
      }
      assertSessionAllowed(name)
      if (normalizedCwd) await assertCwdExists(hostId, normalizedCwd)
      const newSessionArgs = ['-d', '-s', name, '-e', 'TMUXGO_ENV=1']
      if (normalizedCwd) newSessionArgs.push('-c', normalizedCwd)
      // 先抬全局下限再建 session：首个 pane 在创建时固化 history-limit，事后改不回来
      await raiseServerHistoryLimit(hostId)
      await execTmux(hostId, ['new-session', ...newSessionArgs])
      await applyCreatedSessionDefaults(hostId, name)
      if (layout?.windows?.length) {
        try {
          const layoutWithCwd: SessionTemplateLayout = normalizedCwd
            ? {
                windows: layout.windows.map((window) => ({
                  ...window,
                  panes: window.panes.map((pane) => ({ ...pane, cwd: pane.cwd || normalizedCwd })),
                })),
              }
            : layout
          await applyTemplateLayout(hostId, name, layoutWithCwd)
        } catch (err) {
          await cleanupSession(hostId, name)
          throw new Error(errorMessage(err, 'Template layout failed'), { cause: err })
        }
      }
      await prepareSessionAttach(hostId, name)
      const sessions = await getHostTmuxSessions(hostId)
      const created = sessions.find((s) => s.name === name) || {
        id: buildSessionId(hostId, name),
        hostId,
        name,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      }
      emitPluginEvent('session.created', { hostId, sessionId: created.id, sessionName: name })
      return { ...created, cwd: normalizedCwd }
    } catch (err) {
      if (errorMessage(err).includes('duplicate session')) {
        const sessions = await getHostTmuxSessions(hostId)
        const existingSession = sessions.find((s) => s.name === name)
        if (existingSession) return { ...existingSession, cwd: normalizedCwd, existed: true }
      }
      throw new Error(errorMessage(err), { cause: err })
    }
  })
  fastify.post('/hosts/:hostId/sessions/rename', async (request) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const { sessionId, name } = sessionRenameBodySchema.parse(request.body)
    const sessionName = normalizeSessionName(hostId, sessionId)
    if (!isValidSessionName(name)) throw new Error('Invalid session name')
    assertSessionAllowed(sessionName)
    assertSessionAllowed(name)
    try {
      await execTmux(hostId, ['rename-session', '-t', sessionName, name])
      await prepareSessionAttach(hostId, name)
      const sessions = await getHostTmuxSessions(hostId)
      const renamed = sessions.find((session) => session.name === name) || {
        id: buildSessionId(hostId, name),
        hostId,
        name,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      }
      emitPluginEvent('session.renamed', {
        hostId,
        sessionId: renamed.id,
        sessionName: name,
        previousSessionName: sessionName,
      })
      return renamed
    } catch (err) {
      throw new Error(errorMessage(err), { cause: err })
    }
  })
  fastify.post('/hosts/:hostId/sessions/batch-delete', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const body = (request.body || {}) as BatchDeleteRequest
    const mode: BatchDeleteMode = body.mode === 'execute' ? 'execute' : 'preview'
    const limit = normalizeBatchLimit(body.limit)
    const sessions = await getHostTmuxSessions(hostId)
    const { matched, eligible, skipped } = getBatchDeleteSelection(hostId, sessions, body)
    const forceRequired = eligible.length > limit
    const limited = eligible.slice(0, limit)
    if (mode === 'preview') {
      return {
        mode,
        limit,
        forceRequired,
        matchedCount: matched.length,
        deletableCount: eligible.length,
        deleteCount: limited.length,
        skipped,
        sessions: limited.map(toBatchDeleteTarget),
      }
    }
    if (forceRequired && body.force !== true)
      throw new Error(`Delete candidate count ${eligible.length} exceeds limit ${limit}, set force=true to continue`)
    const targets = forceRequired && body.force === true ? eligible : limited
    const deleted: BatchDeleteTarget[] = []
    const failed: BatchDeleteSkip[] = []
    for (const session of targets) {
      try {
        await execTmux(hostId, ['kill-session', '-t', exactSessionTarget(session.name)])
        deleted.push(toBatchDeleteTarget(session))
        emitPluginEvent('session.deleted', {
          hostId,
          sessionId: session.id,
          sessionName: session.name,
          source: 'batch-delete',
        })
      } catch (err) {
        failed.push({ sessionId: session.id, name: session.name, reason: errorMessage(err, 'delete_failed') })
      }
    }
    return {
      mode,
      limit,
      forceUsed: body.force === true,
      forceRequired,
      matchedCount: matched.length,
      deletableCount: eligible.length,
      attemptedCount: targets.length,
      deletedCount: deleted.length,
      failedCount: failed.length,
      skipped,
      deleted,
      failed,
    }
  })
  // 导出 session 布局为版本化 JSON：仅窗口名/pane 顺序/分栏/布局/cwd/命令名，
  // 不含 env、命令行参数与 pane 输出（避免泄露 token/密钥）
  fastify.get('/hosts/:hostId/sessions/:sessionId/layout', async (request) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const { sessionId } = request.params as { sessionId: string }
    const sessionName = normalizeSessionName(hostId, sessionId)
    assertSessionAllowed(sessionName)
    const sessions = await getHostTmuxSessions(hostId)
    if (!sessions.some((session) => session.name === sessionName)) throw new Error(`Session not found: ${sessionName}`)
    const { stdout: windowsOut } = await execTmux(hostId, [
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{window_index}|#{window_name}',
    ])
    const { stdout: panesOut } = await execTmux(hostId, [
      'list-panes',
      '-s',
      '-t',
      sessionName,
      '-F',
      '#{window_index}|#{pane_index}|#{pane_current_path}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{@tmuxgo_task}',
    ])
    const panesByWindow = new Map<string, SessionLayoutPaneRow[]>()
    for (const line of panesOut.trim().split('\n').filter(Boolean)) {
      const [windowIndex, paneIndex, cwd, command, width, height, left, top, task] = line.split('|')
      const rows = panesByWindow.get(windowIndex) || []
      rows.push({
        index: parseInt(paneIndex, 10) || 0,
        cwd: cwd || '',
        command: command || '',
        width: parseInt(width, 10) || 0,
        height: parseInt(height, 10) || 0,
        left: parseInt(left, 10) || 0,
        top: parseInt(top, 10) || 0,
        ...(task ? { task } : {}),
      })
      panesByWindow.set(windowIndex, rows)
    }
    // window_name 可能含 '|'：首字段取 window_index，其余并回名字
    const windows = windowsOut
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [windowIndex, ...nameParts] = line.split('|')
        return { name: nameParts.join('|') || `win-${windowIndex}`, panes: panesByWindow.get(windowIndex) || [] }
      })
      .filter((window) => window.panes.length)
    return buildSessionLayoutDocument({ sessionName, hostId, windows })
  })
  // 导入 layout：mode=create 建新 session（已存在须 replace:true 才会先销毁重建）；
  // mode=append 把布局窗口追加到已有 session，不破坏现有窗口/pane
  fastify.post('/hosts/:hostId/session-layouts/apply', async (request) => {
    const { hostId } = hostParamsSchema.parse(request.params)
    const body = sessionLayoutApplyBodySchema.parse(request.body)
    const doc = normalizeSessionLayoutDocument(body.layout)
    const layout = sessionLayoutToTemplateLayout(doc)
    const mode = body.mode === 'append' ? 'append' : 'create'
    const sessionName =
      mode === 'append' && body.sessionId ? normalizeSessionName(hostId, body.sessionId) : body.name?.trim() || doc.name
    assertSessionAllowed(sessionName)
    await assertLayoutCwdsExist(hostId, layout)
    const sessions = await getHostTmuxSessions(hostId)
    const existing = sessions.find((session) => session.name === sessionName)
    if (mode === 'append') {
      if (!existing) throw new Error(`Session not found: ${sessionName}`)
      await applySessionLayoutAppend(hostId, sessionName, layout)
      return { session: existing, mode, appendedWindows: layout.windows.length }
    }
    if (existing && body.replace !== true)
      throw new Error(`Session already exists: ${sessionName} (set replace=true to overwrite)`)
    if (existing) await execTmux(hostId, ['kill-session', '-t', exactSessionTarget(sessionName)])
    try {
      await raiseServerHistoryLimit(hostId)
      // 首 pane 的 cwd 走 new-session -c，与快照恢复同一条规则（见 buildSessionCreateArgs）
      await execTmux(hostId, buildSessionCreateArgs(sessionName, layout))
      await applyCreatedSessionDefaults(hostId, sessionName)
      await applyTemplateLayout(hostId, sessionName, layout)
    } catch (err) {
      await cleanupSession(hostId, sessionName)
      throw new Error(errorMessage(err, 'Layout apply failed'), { cause: err })
    }
    await prepareSessionAttach(hostId, sessionName)
    const created = (await getHostTmuxSessions(hostId)).find((session) => session.name === sessionName) || {
      id: buildSessionId(hostId, sessionName),
      hostId,
      name: sessionName,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      windowCount: layout.windows.length || 1,
      attached: false,
    }
    emitPluginEvent('session.created', { hostId, sessionId: created.id, sessionName })
    return { session: { ...created, replaced: !!existing }, mode }
  })
  fastify.delete('/hosts/:hostId/sessions/:sessionId', async (request) => {
    const { hostId, sessionId } = request.params as { hostId: string; sessionId: string }
    const sessionName = normalizeSessionName(hostId, sessionId)
    assertSessionAllowed(sessionName)
    try {
      await execTmux(hostId, ['kill-session', '-t', exactSessionTarget(sessionName)])
      emitPluginEvent('session.deleted', { hostId, sessionId: buildSessionId(hostId, sessionName), sessionName })
      return { success: true, sessionId: buildSessionId(hostId, sessionName) }
    } catch (err) {
      throw new Error(errorMessage(err), { cause: err })
    }
  })
  // 读原生 layout string：GET /layout-string?windowId=@3（缺省取 active window）。
  // 同时给出 pane 数与窗口尺寸，前端不必再为「这串能不能套回去」单独探测。
  fastify.get('/hosts/:hostId/sessions/:sessionId/layout-string', async (request, reply) => {
    try {
      const hostId = layoutHostId(request.params)
      const { sessionId } = request.params as { sessionId: string }
      const rawWindowId = (request.query as { windowId?: unknown }).windowId
      if (rawWindowId !== undefined && (typeof rawWindowId !== 'string' || !layoutWindowIdPattern.test(rawWindowId)))
        throw new LayoutRouteError(400, 'INVALID_WINDOW_ID', 'windowId must match @<number>')
      await assertLayoutHost(hostId)
      const sessionName = layoutSessionName(hostId, sessionId)
      assertRequestScopeAllowsSession(request, hostId, sessionName)
      const windowId = await resolveLayoutWindow(hostId, sessionName, rawWindowId as string | undefined)
      const { stdout: layoutOut } = await execTmux(hostId, [
        'display-message',
        '-p',
        '-t',
        windowId,
        '#{window_layout}',
      ])
      const { stdout: sizeOut } = await execTmux(hostId, [
        'display-message',
        '-p',
        '-t',
        windowId,
        '#{window_width}|#{window_height}',
      ])
      const layout = layoutOut.trim()
      // tmux 给回来的串必须过同一套校验：格式假设一旦漂移，宁可报错也不把脏串发给前端
      validateLayoutString(layout)
      const [cols, rows] = sizeOut
        .trim()
        .split('|')
        .map((value) => Number.parseInt(value, 10) || 0)
      const panes = await countWindowPanes(hostId, windowId)
      return { ok: true, windowId, layout, panes, cols, rows }
    } catch (err) {
      return sendLayoutError(reply, err)
    }
  })
  // 套用 layout string：POST /layout-string/apply { windowId, layout }。
  // 只改几何：pane 数对不上直接 400（LAYOUT_PANE_MISMATCH），不做 pane 自动补齐。
  fastify.post('/hosts/:hostId/sessions/:sessionId/layout-string/apply', async (request, reply) => {
    try {
      const hostId = layoutHostId(request.params)
      const { sessionId } = request.params as { sessionId: string }
      const body = (request.body ?? {}) as { windowId?: unknown; layout?: unknown }
      if (typeof body.windowId !== 'string' || !layoutWindowIdPattern.test(body.windowId))
        throw new LayoutRouteError(400, 'INVALID_WINDOW_ID', 'windowId must match @<number>')
      const layout = typeof body.layout === 'string' ? body.layout.trim() : ''
      validateLayoutString(layout)
      await assertLayoutHost(hostId)
      const sessionName = layoutSessionName(hostId, sessionId)
      assertRequestScopeAllowsSession(request, hostId, sessionName)
      const windowId = await resolveLayoutWindow(hostId, sessionName, body.windowId)
      const panes = await countWindowPanes(hostId, windowId)
      assertLayoutPaneCount(layout, panes)
      try {
        await execTmux(hostId, ['select-layout', '-t', windowId, layout])
      } catch (err) {
        // tmux 会自己复核校验和/几何可行性（报 `invalid layout: …` / `size too small …`）：
        // 这仍属「调用方给的串不合用」，按 400 回，别让人以为是 gateway 挂了
        const message = errorMessage(err, 'select-layout failed')
        if (/invalid layout|size too small/i.test(message)) throw new LayoutRouteError(400, 'LAYOUT_INVALID', message)
        throw err
      }
      return { ok: true, windowId, panes }
    } catch (err) {
      return sendLayoutError(reply, err)
    }
  })
}
