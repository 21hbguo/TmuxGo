import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  describeRecoveryCandidate,
  getRecoveryCandidate,
  inspectPaneRowFromList,
  inspectRecoveryPanes,
  listRecoveryCandidates,
  RecoveryError,
  resumeRecoveryCandidate,
} from '../lib/agent-recovery.js'
import { agentRecoveryResumeBodySchema } from '../lib/request-validation.js'
import { assertSessionAllowed } from '../lib/tmux-policy.js'

const apiVersion = 1
function recoveryError(reply: FastifyReply, error: unknown) {
  if (error instanceof RecoveryError) {
    const status =
      error.code === 'candidate_not_found'
        ? 404
        : error.code === 'already_resumed' ||
            error.code === 'pane_occupied' ||
            error.code === 'pane_dead' ||
            error.code === 'pane_in_mode'
          ? 409
          : 400
    return reply.code(status).send({ message: error.message, code: error.code })
  }
  throw error
}
// 查询时做一次全量 pane 探测，逐候选标 occupant/resumable；
// 探测失败（host 离线）不拦截列表——resume 路径仍有权威复检
export async function agentRecoveryRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/agent-recovery', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const candidates = await listRecoveryCandidates(hostId)
    const inspections = await inspectRecoveryPanes(hostId)
    return {
      version: apiVersion,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        ...describeRecoveryCandidate(
          candidate,
          candidate.tmuxPaneId ? inspectPaneRowFromList(inspections, candidate.tmuxPaneId) : undefined,
        ),
      })),
    }
  })
  fastify.post('/hosts/:hostId/agent-recovery/:candidateId/resume', async (request, reply) => {
    const { hostId, candidateId } = request.params as { hostId: string; candidateId: string }
    const body = agentRecoveryResumeBodySchema.parse(request.body)
    const candidate = await getRecoveryCandidate(hostId, candidateId)
    if (!candidate)
      return reply.code(404).send({ message: 'Recovery candidate not found or expired', code: 'candidate_not_found' })
    try {
      assertSessionAllowed(candidate.sessionName)
    } catch (error) {
      return reply.code(403).send({
        message: error instanceof Error ? error.message : 'Session is not allowed',
        code: 'session_not_allowed',
      })
    }
    try {
      return await resumeRecoveryCandidate(hostId, candidateId, body)
    } catch (error) {
      return recoveryError(reply, error)
    }
  })
}
