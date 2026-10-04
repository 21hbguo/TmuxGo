import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'
import {
  agentControl,
  readAgentPane,
  resolveAgentWaitTarget,
  splitAgentPane,
  type AgentWaitCondition,
  type AgentWaitTarget,
} from '../lib/agent-control.js'
import {
  controlAgentCancelBodySchema,
  controlAgentPromptBodySchema,
  controlAgentStartBodySchema,
  controlReadBodySchema,
  controlSplitBodySchema,
  controlWaitBodySchema,
} from '../lib/control-protocol.js'
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
export async function agentControlRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/control/panes/split', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlSplitBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const createdPaneId = await splitAgentPane(hostId, tmuxPaneId, body.direction, body.cwd)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: createdPaneId ? `${hostId}:${createdPaneId}` : undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pane split failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_SPLIT_FAILED' })
    }
  })
  fastify.post('/v1/control/panes/read', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlReadBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = parseHostPaneId(body.paneId)
      await assertKnownHost(hostId)
      if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
      const output = await readAgentPane(hostId, tmuxPaneId, body.lines)
      reply.header('cache-control', 'no-store')
      return { ok: true, paneId: body.paneId, output }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pane read failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_READ_FAILED' })
    }
  })
  fastify.post('/v1/control/agent/wait', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    try {
      const body = controlWaitBodySchema.parse(request.body)
      const target = body.target as AgentWaitTarget
      const { hostId } = resolveAgentWaitTarget(target, body.hostId || 'local')
      await assertKnownHost(hostId)
      const condition = body.condition as AgentWaitCondition
      const result = await agentControl.wait(target, condition, { hostId, timeoutMs: body.timeoutMs })
      reply.header('cache-control', 'no-store')
      return { ok: true, waitId: result.waitId, elapsedMs: result.elapsedMs, pane: result.pane }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'].includes((error as { code: string }).code)
      ) {
        return reply.code(409).send({ ok: false, message: error.message, code: (error as { code: string }).code })
      }
      const message = error instanceof Error ? error.message : 'Agent wait failed'
      return reply.code(400).send({ message, code: 'AGENT_CONTROL_WAIT_FAILED' })
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
      ['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'].includes((error as { code: string }).code)
    )
      return 409
    return 400
  }
  // display-message 无法解析目标 = pane 不存在：翻成语义码而非通用 400
  const assertActionTargetAllowed = async (tmuxPaneId: string) => {
    try {
      await assertTargetAllowed(tmuxPaneId)
    } catch (error) {
      if (error instanceof Error && error.message === 'Unable to resolve session')
        throw new AgentActionError('PANE_MISSING', 'Target pane no longer exists')
      throw error
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
      return reply
        .code(status)
        .send({
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
      return reply
        .code(status)
        .send({
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
      return reply
        .code(status)
        .send({
          ok: false,
          message: error instanceof Error ? error.message : 'Agent cancel failed',
          code: error instanceof AgentActionError ? error.code : 'AGENT_CONTROL_CANCEL_FAILED',
        })
    }
  })
}
