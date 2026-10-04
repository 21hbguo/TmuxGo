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
  controlReadBodySchema,
  controlRunBodySchema,
  controlSnapshotBodySchema,
  controlSplitBodySchema,
  controlWaitBodySchema,
  controlWaitOutputBodySchema,
} from '../lib/control-protocol.js'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { getHostById } from '../lib/hosts.js'
import { agentManager } from '../agent-manager.js'
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
const waitSemanticCodes = new Set(['OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'])
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
    try {
      const body = controlWaitOutputBodySchema.parse(request.body)
      const { hostId, tmuxPaneId } = await parsePaneTarget(body.paneId)
      const result = await waitAgentPaneOutput(hostId, tmuxPaneId, {
        match: body.match,
        regex: body.regex,
        lines: body.lines,
        timeoutMs: body.timeoutMs,
      })
      reply.header('cache-control', 'no-store')
      return { ok: true, ...result }
    } catch (error) {
      return controlError(reply, error, 'AGENT_CONTROL_WAIT_OUTPUT_FAILED')
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
      return controlError(reply, error, 'AGENT_CONTROL_WAIT_FAILED')
    }
  })
}
