import { z } from 'zod'

// /api/v1/control 协议契约单一事实源（docs/agent-control/PROTOCOL.md 契约章节的实现侧）。
// 兼容性约定：zod object 默认剥离未知字段，新增可选字段向后兼容；
// 任何破坏性变更（改字段语义/删字段）必须 bump CONTROL_PROTOCOL_VERSION 并同步文档。

export const CONTROL_PROTOCOL_VERSION = 'v1'
// 协议版本协商：目前只有 v1；新增版本追加到数组尾部，DEFAULT 永远指当前默认
export const SUPPORTED_CONTROL_PROTOCOL_VERSIONS = ['v1'] as const
export const DEFAULT_CONTROL_PROTOCOL_VERSION: (typeof SUPPORTED_CONTROL_PROTOCOL_VERSIONS)[number] =
  CONTROL_PROTOCOL_VERSION
export type ControlProtocolVersion = (typeof SUPPORTED_CONTROL_PROTOCOL_VERSIONS)[number]

export const paneIdSchema = z.string().min(3).max(256)

// initialize：客户端可声明期望的协议版本；缺省 = 旧客户端，按默认版本兼容应答。
// 版本本身做宽松 string 校验——未知版本走 UNSUPPORTED_PROTOCOL_VERSION 明确错误
// 而不是 zod enum 的通用失败（协商语义需要区分「非法输入」与「版本不支持」）
export const controlInitializeBodySchema = z.object({
  protocolVersion: z.string().min(1).max(32).optional(),
})

// capability = 方法名（canonical method name），与 control-schema.ts 的 CONTROL_METHODS 一一对应
export const CONTROL_CAPABILITIES = [
  'initialize',
  'schema',
  'panes.split',
  'panes.read',
  'panes.snapshot',
  'panes.wait-output',
  'panes.run',
  'agent.wait',
  'agent.start',
  'agent.prompt',
  'agent.cancel',
  'push',
  'open-target',
  'inbox',
  'browser',
] as const
export type ControlCapability = (typeof CONTROL_CAPABILITIES)[number]

export const controlSplitBodySchema = z.object({
  paneId: paneIdSchema,
  direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
  cwd: z.string().max(4096).optional(),
})

export const controlReadBodySchema = z.object({
  paneId: paneIdSchema,
  lines: z.number().int().min(1).max(2000).optional(),
})

// snapshot：结构化非敏感 pane 状态；tail 行数封顶防无界历史
export const controlSnapshotBodySchema = z.object({
  paneId: paneIdSchema,
  lines: z.number().int().min(1).max(100).optional(),
})

// wait-output：服务端持有轮询 tail。match 缺省 = 等任意输出变化；
// regex=true 时按正则匹配（长度封顶，防巨长 pattern 输入）
export const controlWaitOutputBodySchema = z.object({
  paneId: paneIdSchema,
  match: z.string().min(1).max(512).optional(),
  regex: z.boolean().default(false),
  lines: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(250).max(600000).optional(),
})

const inboxRouteSchema = z.object({
  hostId: z.string().max(128).optional(),
  sessionName: z.string().max(64).optional(),
  paneId: z.string().max(256).optional(),
  tmuxPaneId: z
    .string()
    .regex(/^%[0-9]+$/)
    .optional(),
})
const inboxSourceSchema = z.object({
  provider: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  agentSessionId: z.string().max(128).optional(),
})
export const controlPushBodySchema = z.object({
  type: z.enum(['text', 'image', 'video', 'file', 'link']),
  title: z.string().max(160).optional(),
  text: z.string().max(262144).optional(),
  linkUrl: z.string().max(4096).optional(),
  path: z.string().max(4096).optional(),
  base64: z.string().max(44739244).optional(),
  name: z.string().max(256).optional(),
  mime: z.string().max(128).optional(),
  open: z.boolean().optional(),
  dedupeKey: z.string().max(128).optional(),
  route: inboxRouteSchema.optional(),
  source: inboxSourceSchema.optional(),
  expiresInMs: z.number().int().positive().max(2592000000).optional(),
})
export const controlOpenTargetBodySchema = z.object({
  route: inboxRouteSchema.optional(),
  messageId: z.string().max(128).optional(),
})
export const controlInboxBodySchema = z.object({
  id: z.string().max(128).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  sessionName: z.string().max(64).optional(),
  paneId: z.string().max(256).optional(),
})

// Browser agent control uses one guarded endpoint and an explicit op union. The
// union stays in this protocol source so CLI/MCP clients cannot invent a shell fallback.
export const controlBrowserBodySchema = z.union([
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('launch') }),
  z.object({ op: z.literal('stop') }),
  z.object({ op: z.literal('navigate'), url: z.string().min(1).max(4096), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('back'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('forward'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('reload'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('snapshot'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('click'), ref: z.string().max(64), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('type'),
    ref: z.string().max(64),
    text: z.string().max(8192),
    targetId: z.string().max(256).optional(),
  }),
  z.object({ op: z.literal('press'), key: z.string().max(64), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('scroll'),
    dx: z.number().default(0),
    dy: z.number().default(0),
    targetId: z.string().max(256).optional(),
  }),
  z.object({ op: z.literal('screenshot'), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('eval'),
    expression: z.string().min(1).max(65536),
    targetId: z.string().max(256).optional(),
  }),
  z.object({
    op: z.literal('pick'),
    targetId: z.string().max(256).optional(),
    timeoutMs: z.number().int().min(1).max(120000).optional(),
  }),
  z.object({ op: z.literal('pickCancel'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('tabs') }),
  z.object({ op: z.literal('open'), url: z.string().min(1).max(4096) }),
  z.object({ op: z.literal('close'), targetId: z.string().min(1).max(256) }),
  z.object({ op: z.literal('activate'), targetId: z.string().min(1).max(256) }),
])

// run：只向经过 pane target 校验的 pane 送字面按键。enter 默认 true；
// 目标 pane 非 shell occupant 时必须显式 allowOccupied 确认（往运行中
// 程序打字=显式知情操作）
export const controlRunBodySchema = z.object({
  paneId: paneIdSchema,
  text: z.string().min(1).max(4096),
  enter: z.boolean().default(true),
  allowOccupied: z.boolean().default(false),
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

const actionAckTimeout = z.number().int().min(250).max(30000)
// 客户端可自带 opId 作幂等键：ack 等待期间请求未返回，仍可按已知 opId cancel
const actionOpId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
export const controlAgentStartBodySchema = z.object({
  paneId: paneIdSchema,
  provider: z.enum(['claude', 'codex']),
  // 单 token 参数（--resume xxx 形态）；逐 token 再经 actionArgPattern 复核，
  // 与 lib/agent-actions.ts 的 allowlist 是同一契约
  args: z
    .array(z.string().regex(/^-{0,2}[A-Za-z0-9][A-Za-z0-9._:/=-]{0,126}$/))
    .max(8)
    .optional(),
  ackTimeoutMs: actionAckTimeout.optional(),
  opId: actionOpId.optional(),
})
export const controlAgentPromptBodySchema = z.object({
  paneId: paneIdSchema,
  prompt: z.string().min(1).max(8192),
  ackTimeoutMs: actionAckTimeout.optional(),
  opId: actionOpId.optional(),
})
export const controlAgentCancelBodySchema = z.object({
  opId: z.string().min(1).max(128),
})

// 稳定错误码表（HTTP status + code 是契约的一部分，文档保持同步）：
// 401 AGENT_CONTROL_AUTH_REQUIRED  缺少/错误 agent token
// 403 TMUXGO_ENV_GUARD             缺少 x-tmuxgo-env: 1 守卫头
// 400 AGENT_CONTROL_SPLIT_FAILED / AGENT_CONTROL_READ_FAILED / AGENT_CONTROL_WAIT_FAILED /
//     AGENT_CONTROL_SNAPSHOT_FAILED / AGENT_CONTROL_WAIT_OUTPUT_FAILED / AGENT_CONTROL_RUN_FAILED /
//     AGENT_CONTROL_START_FAILED / AGENT_CONTROL_PROMPT_FAILED / AGENT_CONTROL_CANCEL_FAILED
//     AGENT_CONTROL_SEND_FAILED / INVALID_ARGUMENT / PROVIDER_NOT_SUPPORTED
//     请求体校验失败或下游执行失败（message 携带原因）
// 400 INVALID_INPUT / INVALID_PATTERN  run 文本含控制字符 / wait-output 正则不合法
// 409 OCCUPANT_CHANGED / PANE_REMOVED / TIMEOUT / INVALID_TARGET  agent/wait 语义错误
// 409 PANE_MISSING / PANE_DEAD / PANE_IN_MODE / PANE_OCCUPIED
//     pane 请求时状态不可执行（snapshot/run/wait-output/start/prompt 共用）
//     PANE_NOT_AGENT / PANE_UNKNOWN / ACK_TIMEOUT / OPERATION_CANCELLED  start/prompt 语义错误
// 400 AGENT_CONTROL_INITIALIZE_FAILED  initialize body 校验失败
// 400 UNSUPPORTED_PROTOCOL_VERSION    initialize 声明了不在支持列表的协议版本
// 429 AGENT_CONTROL_QUOTA_EXCEEDED  每 host 在途操作上界
export const CONTROL_ERROR_CODES = [
  'AGENT_CONTROL_AUTH_REQUIRED',
  'TMUXGO_ENV_GUARD',
  'AGENT_CONTROL_SPLIT_FAILED',
  'AGENT_CONTROL_READ_FAILED',
  'AGENT_CONTROL_WAIT_FAILED',
  'AGENT_CONTROL_SNAPSHOT_FAILED',
  'AGENT_CONTROL_WAIT_OUTPUT_FAILED',
  'AGENT_CONTROL_RUN_FAILED',
  'INVALID_INPUT',
  'INVALID_PATTERN',
  'AGENT_CONTROL_START_FAILED',
  'AGENT_CONTROL_PROMPT_FAILED',
  'AGENT_CONTROL_CANCEL_FAILED',
  'AGENT_CONTROL_QUOTA_EXCEEDED',
  'AGENT_CONTROL_SEND_FAILED',
  'OCCUPANT_CHANGED',
  'PANE_REMOVED',
  'TIMEOUT',
  'INVALID_TARGET',
  'INVALID_ARGUMENT',
  'PROVIDER_NOT_SUPPORTED',
  'PANE_MISSING',
  'PANE_DEAD',
  'PANE_IN_MODE',
  'PANE_OCCUPIED',
  'PANE_NOT_AGENT',
  'PANE_UNKNOWN',
  'ACK_TIMEOUT',
  'OPERATION_CANCELLED',
  'AGENT_CONTROL_INITIALIZE_FAILED',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'AGENT_PUSH_FAILED',
  'AGENT_OPEN_TARGET_FAILED',
  'AGENT_INBOX_QUERY_FAILED',
  'INBOX_MESSAGE_NOT_FOUND',
  'BROWSER_BAD_OP',
  'BROWSER_OP_FAILED',
] as const
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number]
