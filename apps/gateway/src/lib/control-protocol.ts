import { z } from 'zod'

// /api/v1/control 协议契约单一事实源（docs/agent-control/PROTOCOL.md 契约章节的实现侧）。
// 兼容性约定：zod object 默认剥离未知字段，新增可选字段向后兼容；
// 任何破坏性变更（改字段语义/删字段）必须 bump CONTROL_PROTOCOL_VERSION 并同步文档。

export const CONTROL_PROTOCOL_VERSION = 'v1'

export const paneIdSchema = z.string().min(3).max(256)

export const controlSplitBodySchema = z.object({
  paneId: paneIdSchema,
  direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
  cwd: z.string().max(4096).optional(),
})

export const controlReadBodySchema = z.object({
  paneId: paneIdSchema,
  lines: z.number().int().min(1).max(2000).optional(),
})

export const controlWaitBodySchema = z.object({
  hostId: z.string().min(1).max(128).optional(),
  target: z.union([
    z.object({ paneId: paneIdSchema }),
    z.object({ sessionName: z.string().min(1).max(64), agent: z.string().min(1).max(64) }),
  ]),
  condition: z
    .object({
      status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']).optional(),
      phase: z
        .enum([
          'idle',
          'working',
          'needs_input',
          'permission_required',
          'retrying',
          'failed',
          'ended',
          'disconnected',
          'unknown',
        ])
        .optional(),
      lastEvent: z
        .enum([
          'started',
          'permission_required',
          'question_required',
          'completed',
          'failed',
          'retrying',
          'ended',
          'disconnected',
          'reconnected',
        ])
        .optional(),
    })
    .refine((value) => !!(value.status || value.phase || value.lastEvent), {
      message: 'condition requires status, phase, or lastEvent',
    }),
  timeoutMs: z.number().int().min(250).max(600000).optional(),
})

// 稳定错误码表（HTTP status + code 是契约的一部分，文档保持同步）：
// 401 AGENT_CONTROL_AUTH_REQUIRED  缺少/错误 agent token
// 403 TMUXGO_ENV_GUARD             缺少 x-tmuxgo-env: 1 守卫头
// 400 AGENT_CONTROL_SPLIT_FAILED / AGENT_CONTROL_READ_FAILED / AGENT_CONTROL_WAIT_FAILED
//     请求体校验失败或下游 tmux/目标解析失败（message 携带原因）
// 409 OCCUPANT_CHANGED / PANE_REMOVED / TIMEOUT / INVALID_TARGET  agent/wait 语义错误
export const CONTROL_ERROR_CODES = [
  'AGENT_CONTROL_AUTH_REQUIRED',
  'TMUXGO_ENV_GUARD',
  'AGENT_CONTROL_SPLIT_FAILED',
  'AGENT_CONTROL_READ_FAILED',
  'AGENT_CONTROL_WAIT_FAILED',
  'OCCUPANT_CHANGED',
  'PANE_REMOVED',
  'TIMEOUT',
  'INVALID_TARGET',
] as const
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number]
