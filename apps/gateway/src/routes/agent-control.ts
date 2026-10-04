import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'
import {
  agentControl,
  AgentWaitError,
  readAgentPane,
  resolveAgentWaitTarget,
  runAgentPaneInput,
  snapshotAgentPane,
  splitAgentPane,
  waitAgentPaneOutput,
  type AgentWaitCondition,
  type AgentWaitTarget,
} from '../lib/agent-control.js'
import {
  CONTROL_CAPABILITIES,
  SUPPORTED_CONTROL_PROTOCOL_VERSIONS,
  DEFAULT_CONTROL_PROTOCOL_VERSION,
  controlAgentCancelBodySchema,
  controlAgentPromptBodySchema,
  controlAgentStartBodySchema,
  controlInitializeBodySchema,
  controlReadBodySchema,
  controlRunBodySchema,
  controlSnapshotBodySchema,
  controlSplitBodySchema,
  controlWaitBodySchema,
  controlWaitOutputBodySchema,
} from '../lib/control-protocol.js'
import { buildControlProtocolSchema } from '../lib/control-schema.js'
import { AgentActionError, cancelAgentOperation, promptAgentInPane, startAgentInPane } from '../lib/agent-actions.js'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { getHostById } from '../lib/hosts.js'
import { agentManager } from '../agent-manager.js'
import { appendAuditEvent } from '../lib/audit-log.js'
import { getRequestPrincipal } from '../lib/principal.js'
function parseHostPaneId(paneId: string) {
  return resolveAgentWaitTarget({ paneId })
}
async function assertKnownHost(hostId: string) {
  if (hostId !== 'local' && !(await getHostById(hostId)) && !agentManager.getAgent(hostId))
    throw new Error(`Host "${hostId}" is not registered`)
}
// 控制面双守卫：agent token（401）+ x-tmuxgo-env=1（403），所有端点共用
function guardControlRequest(request: FastifyRequest, reply: FastifyReply) {
  if (!isAgentEventToken(getAgentEventToken(request.headers))) {
    void reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    return false
  }
  if (request.headers['x-tmuxgo-env'] !== '1') {
    void reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    return false
  }
  return true
}
// pane 请求时状态错误 → 409 语义码；输入/模式校验 → 400 各自 code；
// 其余（zod/下游执行失败）→ 400 failedCode。code 值是协议契约
const paneStateCodes = new Set(['PANE_MISSING', 'PANE_DEAD', 'PANE_IN_MODE', 'PANE_OCCUPIED'])
const waitSemanticCodes = new Set([
  'OCCUPANT_CHANGED',
  'PANE_REMOVED',
  'TIMEOUT',
  'INVALID_TARGET',
  'CLIENT_DISCONNECTED',
])
const inputCodes = new Set(['INVALID_INPUT', 'INVALID_PATTERN'])
function controlError(reply: FastifyReply, error: unknown, failedCode: string) {
  const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : ''
  const message = error instanceof Error ? error.message : 'Control request failed'
  if (paneStateCodes.has(code) || waitSemanticCodes.has(code)) return reply.code(409).send({ ok: false, message, code })
  if (inputCodes.has(code)) return reply.code(400).send({ ok: false, message, code })
  return reply.code(400).send({ message, code: failedCode })
}
async function parsePaneTarget(paneId: string) {
  const { hostId, tmuxPaneId } = parseHostPaneId(paneId)
  await assertKnownHost(hostId)
  if (hostId === 'local') {
    try {
      await assertTargetAllowed(tmuxPaneId)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      // 会话策略拒绝（非法名/不在允许集）保持 400 通用失败；tmux 目标解析失败
      // （pane 不存在/不可达）映射 PANE_MISSING——调用方据此区分「目标没了」
      if (message === 'Invalid session name' || message === 'Session is not allowed') throw error
      throw new AgentWaitError('PANE_MISSING', `Pane ${tmuxPaneId} does not exist or is unreachable`)
    }
  }
  return { hostId, tmuxPaneId }
}
export async function agentControlRoutes(fastify: FastifyInstance) {
  // initialize：协议版本协商握手。旧客户端不带 protocolVersion → 按默认版本兼容；
  // 未知版本 → 400 UNSUPPORTED_PROTOCOL_VERSION（协商错误，与 zod 校验失败区分）
  fastify.post('/v1/control/initialize', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    try {
      const body = controlInitializeBodySchema.parse(request.body ?? {})
      const requested = body.protocolVersion
      if (requested && !(SUPPORTED_CONTROL_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
        return reply.code(400).send({
          ok: false,
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          message: `Protocol version "${requested}" is not supported`,
          supportedVersions: [...SUPPORTED_CONTROL_PROTOCOL_VERSIONS],
        })
      }
      reply.header('cache-control', 'no-store')
      return {
        ok: true,
        protocolVersion: DEFAULT_CONTROL_PROTOCOL_VERSION,
        supportedVersions: [...SUPPORTED_CONTROL_PROTOCOL_VERSIONS],
        capabilities: [...CONTROL_CAPABILITIES],
      }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_INITIALIZE_FAILED')
    }
  })
  // schema：只读导出正式 JSON Schema 文档（method/params/result/错误码/版本/安全限制），
  // 供 CLI schema 命令、MCP 工具与第三方客户端引用同一份协议定义
  fastify.get('/v1/control/schema', async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    reply.header('cache-control', 'no-store')
    return buildControlProtocolSchema()
  })
  fastify.post('/v1/control/panes/split', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    try {
      const body = controlSplitBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const createdPaneId = await splitAgentPane(hostId, tmuxPaneId, body.direction, body.cwd)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: createdPaneId ? `${hostId}:${createdPaneId}` : undefined }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_SPLIT_FAILED')
    }
  })
  fastify.post('/v1/control/panes/read', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    try {
      const body = controlReadBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const output = await readAgentPane(hostId, tmuxPaneId, body.lines)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: body.paneId, output }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_READ_FAILED')
    }
  })
  fastify.post('/v1/control/panes/snapshot', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    try {
      const body = controlSnapshotBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const snapshot = await snapshotAgentPane(hostId, tmuxPaneId, body.lines)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: body.paneId, snapshot }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_SNAPSHOT_FAILED')
    }
  })
  fastify.post('/v1/control/panes/wait-output', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.raw.once('aborted', abort)
    // POST body 已读完时 request.aborted 不再可靠；响应 close 捕获等待期间断连。
    reply.raw.once('close', abort)
    if (request.raw.aborted || reply.raw.destroyed) abort()
    try {
      const body = controlWaitOutputBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const result = await waitAgentPaneOutput(hostId, tmuxPaneId, {
        match: body.match,
        regex: body.regex,
        lines: body.lines,
        timeoutMs: body.timeoutMs,
        signal: controller.signal,
      })
      reply.header('cache-control', 'no-store')
      return { ok: true, ...result }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_WAIT_OUTPUT_FAILED')
    } finally {
      request.raw.off('aborted', abort)
      reply.raw.off('close', abort)
    }
  })
  fastify.post('/v1/control/panes/run', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    try {
      const body = controlRunBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const result = await runAgentPaneInput(hostId, tmuxPaneId, {
        text: body.text,
        enter: body.enter,
        allowOccupied: body.allowOccupied,
      })
      reply.header('cache-control', 'no-store')
      return result
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_RUN_FAILED')
    }
  })
  fastify.post('/v1/control/agent/wait', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlRequest(request, reply)) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.raw.once('aborted', abort)
    // POST body 已读完时 request.aborted 不再可靠；响应 close 捕获等待期间断连。
    reply.raw.once('close', abort)
    if (request.raw.aborted || reply.raw.destroyed) abort()
    try {
      const body = controlWaitBodySchema.parse(request.body)
      const target = body.target as AgentWaitTarget
      const { hostId } = resolveAgentWaitTarget(target, body.hostId || 'local')
      await assertKnownHost(hostId)
      const condition = body.condition as AgentWaitCondition
      const result = await agentControl.wait(target, condition, {
        hostId,
        timeoutMs: body.timeoutMs,
        signal: controller.signal,
      })
      reply.header('cache-control', 'no-store')
      return { ok: true, waitId: result.waitId, elapsedMs: result.elapsedMs, pane: result.pane }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_WAIT_FAILED')
    } finally {
      request.raw.off('aborted', abort)
      reply.raw.off('close', abort)
    }
  })

  // agent.start / agent.prompt / agent.cancel（Task12）——显式控制语义：
  // start/prompt 即发即返（带 opId），可选 ackTimeoutMs 升级为等 agent 事件确认；
  // cancel 幂等取消在途 ack 等待。审计只记录 action/paneId/provider/结果码——
  // prompt 正文、token、完整命令串一律不落盘
  const auditAction = (
    request: FastifyRequest,
    action: string,
    target: string,
    result: 'success' | 'failure',
    statusCode: number,
    message?: string,
    hostId?: string,
  ) => {
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
      message,
    }).catch(() => {})
  }
  const actionErrorStatus = (error: unknown): number => {
    if (error instanceof AgentActionError) {
      if (error.code === 'AGENT_CONTROL_QUOTA_EXCEEDED') return 429
      if (
        error.code === 'AGENT_CONTROL_SEND_FAILED' ||
        error.code === 'INVALID_ARGUMENT' ||
        error.code === 'PROVIDER_NOT_SUPPORTED'
      )
        return 400
      return 409 // 其余全是 pane/状态/超时语义冲突
    }
    // agentControl.wait 的语义码按 409 透出，与 /agent/wait 保持一致
    if (
      error instanceof Error &&
      'code' in error &&
      ['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET', 'CLIENT_DISCONNECTED'].includes(
        (error as { code: string }).code,
      )
    )
      return 409
    return 400
  }
  // display-message 无法解析目标（pane 不存在、server 未起等）= pane 缺失：
  // 翻成语义码而非通用 400；仅放行 session 策略拒绝（白名单）
  const assertActionTargetAllowed = async (tmuxPaneId: string) => {
    try {
      await assertTargetAllowed(tmuxPaneId)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Invalid session name' || message === 'Session is not allowed') throw error
      throw new AgentActionError('PANE_MISSING', 'Target pane no longer exists')
    }
  }
  const guardControlAction = (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers))) {
      reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
      return false
    }
    if (request.headers['x-tmuxgo-env'] !== '1') {
      reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
      return false
    }
    return true
  }

  fastify.post('/v1/control/agent/start', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlAction(request, reply)) return
    try {
      const body = controlAgentStartBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertActionTargetAllowed(tmuxPaneId)
      const result = await startAgentInPane(hostId, tmuxPaneId, body)
      reply.header('cache-control', 'no-store')
      auditAction(
        request,
        'agent.start',
        body.paneId,
        'success',
        200,
        `${body.provider}${result.acked ? ' acked' : ' sent'}`,
        hostId,
      )
      return { ok: true, ...result }
    } catch (error) {
      const status = actionErrorStatus(error)
      const paneId =
        typeof (request.body as { paneId?: unknown })?.paneId === 'string'
          ? (request.body as { paneId: string }).paneId
          : request.routeOptions.url || request.url.split('?')[0]
      auditAction(
        request,
        'agent.start',
        paneId,
        'failure',
        status,
        error instanceof AgentActionError ? error.code : 'AGENT_CONTROL_START_FAILED',
      )
      return reply.code(status).send({
        ok: false,
        message: error instanceof Error ? error.message : 'Agent start failed',
        code:
          error instanceof AgentActionError || (error instanceof Error && 'code' in error)
            ? (error as { code: string }).code
            : 'AGENT_CONTROL_START_FAILED',
      })
    }
  })

  fastify.post('/v1/control/agent/prompt', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlAction(request, reply)) return
    try {
      const body = controlAgentPromptBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertActionTargetAllowed(tmuxPaneId)
      const result = await promptAgentInPane(hostId, tmuxPaneId, body)
      reply.header('cache-control', 'no-store')
      auditAction(request, 'agent.prompt', body.paneId, 'success', 200, `${result.acked ? 'acked' : 'sent'}`, hostId)
      return { ok: true, ...result }
    } catch (error) {
      const status = actionErrorStatus(error)
      const paneId =
        typeof (request.body as { paneId?: unknown })?.paneId === 'string'
          ? (request.body as { paneId: string }).paneId
          : request.routeOptions.url || request.url.split('?')[0]
      auditAction(
        request,
        'agent.prompt',
        paneId,
        'failure',
        status,
        error instanceof AgentActionError ? error.code : 'AGENT_CONTROL_PROMPT_FAILED',
      )
      return reply.code(status).send({
        ok: false,
        message: error instanceof Error ? error.message : 'Agent prompt failed',
        code:
          error instanceof AgentActionError || (error instanceof Error && 'code' in error)
            ? (error as { code: string }).code
            : 'AGENT_CONTROL_PROMPT_FAILED',
      })
    }
  })

  fastify.post('/v1/control/agent/cancel', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!guardControlAction(request, reply)) return
    try {
      const body = controlAgentCancelBodySchema.parse(request.body)
      const result = cancelAgentOperation(body.opId)
      reply.header('cache-control', 'no-store')
      auditAction(request, 'agent.cancel', body.opId, 'success', 200, result.state)
      return { ok: true, opId: body.opId, ...result }
    } catch (error) {
      const status = actionErrorStatus(error)
      auditAction(
        request,
        'agent.cancel',
        request.routeOptions.url || request.url.split('?')[0],
        'failure',
        status,
        'AGENT_CONTROL_CANCEL_FAILED',
      )
      return reply.code(status).send({
        ok: false,
        message: error instanceof Error ? error.message : 'Agent cancel failed',
        code: error instanceof AgentActionError ? error.code : 'AGENT_CONTROL_CANCEL_FAILED',
      })
    }
  })
}
