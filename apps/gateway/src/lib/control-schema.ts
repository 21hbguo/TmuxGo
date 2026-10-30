import { z } from 'zod'
import {
  CONTROL_CAPABILITIES,
  CONTROL_ERROR_CODES,
  CONTROL_PROTOCOL_VERSION,
  SUPPORTED_CONTROL_PROTOCOL_VERSIONS,
  controlAgentCancelBodySchema,
  controlAgentPromptBodySchema,
  controlAgentStartBodySchema,
  controlBrowserBodySchema,
  controlExplainBodySchema,
  controlFleetListBodySchema,
  controlInboxBodySchema,
  controlOpenTargetBodySchema,
  controlPaneTaskBodySchema,
  controlPushBodySchema,
  controlInitializeBodySchema,
  controlReadBodySchema,
  controlRunBodySchema,
  controlSendKeysBodySchema,
  controlSnapshotBodySchema,
  controlSplitBodySchema,
  controlWaitBodySchema,
  controlWaitOutputBodySchema,
} from './control-protocol.js'

// 协议文档生成：把 control-protocol.ts 的 zod 请求模型内省成 JSON Schema (draft 2020-12)，
// 供 CLI/MCP/第三方客户端引用同一份协议定义。zod@3 无官方 toJSONSchema（zod/v4 才有），
// 这里实现协议用到的最小子集——新增 zod 类型时同步扩展 SUPPORTED 并在测试中断言覆盖。
// 注意：生成的 schema 只描述「服务端接受什么」，不含 token/环境变量/终端输出示例。

export interface JsonSchema {
  [key: string]: unknown
}

// zod4 自带官方 toJSONSchema（zod3 没有，早期这里是手写的内省器，靠 _def.typeName 分派）。
// 升级 zod4 后 _def 结构整体改名（typeName → type），手写内省器直接崩；改用官方实现，
// 少一层与 zod 内部结构绑定的维护面。
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as JsonSchema
  return normalizeWireSchema(json)
}

// 两处与官方输出的差异需要拉回契约本意：
// 1) 官方在每个根节点带 $schema，我们只在协议文档顶层声明一次，嵌套层全部剥掉；
// 2) zod 的 object 默认 strip 未知字段，等价于「接受但不透传」——契约里如实写
//    additionalProperties: true，否则第三方客户端会以为多传字段会被拒。
function normalizeWireSchema(schema: JsonSchema): JsonSchema {
  const { $schema: _ignored, ...rest } = schema
  const out: JsonSchema = { ...rest }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = true
  }
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, JsonSchema>).map(([key, value]) => [
        key,
        normalizeWireSchema(value),
      ]),
    )
  }
  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) {
    out.items = normalizeWireSchema(out.items as JsonSchema)
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[key]
    if (Array.isArray(branches)) out[key] = branches.map((branch) => normalizeWireSchema(branch as JsonSchema))
  }
  return out
}

const PANE_ID_EXAMPLE = 'local:%0'
// 成功 envelope 的 result 段（不含 ok:true，装配时合并）；响应形状来自路由实现，
// 是契约的一部分——改路由返回字段必须同步这里（contract 测试覆盖字段名）
const RESULT_SCHEMAS: Record<string, JsonSchema> = {
  initialize: {
    type: 'object',
    properties: {
      protocolVersion: { type: 'string', enum: [...SUPPORTED_CONTROL_PROTOCOL_VERSIONS] },
      supportedVersions: { type: 'array', items: { type: 'string' } },
      capabilities: { type: 'array', items: { type: 'string', enum: [...CONTROL_CAPABILITIES] } },
    },
    required: ['protocolVersion', 'supportedVersions', 'capabilities'],
  },
  schema: { type: 'object' },
  'panes.split': {
    type: 'object',
    properties: { paneId: { type: 'string', examples: [PANE_ID_EXAMPLE] } },
  },
  'panes.read': {
    type: 'object',
    properties: { paneId: { type: 'string' }, output: { type: 'string' } },
    required: ['paneId', 'output'],
  },
  'panes.snapshot': {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      snapshot: {
        type: 'object',
        description:
          'Non-sensitive pane state: command/title/cwd/dead/inMode/active/size plus a bounded tail. No env vars, tokens or unbounded history.',
      },
    },
    required: ['paneId', 'snapshot'],
  },
  'panes.wait-output': {
    type: 'object',
    properties: {
      waitId: { type: 'string' },
      elapsedMs: { type: 'integer' },
      matched: { type: 'boolean' },
      changed: { type: 'boolean' },
      output: { type: 'string', description: 'Capped recent tail' },
    },
  },
  'panes.run': {
    type: 'object',
    properties: { paneId: { type: 'string' }, target: { type: 'string' } },
  },
  'panes.send-keys': {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      target: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Canonical tmux key names actually sent' },
    },
    required: ['paneId', 'target', 'keys'],
  },
  'panes.task': {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      task: { type: ['string', 'null'], description: 'Trimmed task id; null after clearing the binding' },
    },
    required: ['paneId', 'task'],
  },
  'fleet.list': {
    type: 'object',
    properties: {
      capturedAt: { type: 'string', description: 'When the cached projection was read (not a fresh scan)' },
      summary: {
        type: 'object',
        description: 'Counts over the matched set before limit truncation',
        properties: {
          idle: { type: 'integer' },
          working: { type: 'integer' },
          blocked: { type: 'integer' },
          done: { type: 'integer' },
          unknown: { type: 'integer' },
          total: { type: 'integer' },
        },
        required: ['idle', 'working', 'blocked', 'done', 'unknown', 'total'],
      },
      panes: {
        type: 'array',
        description:
          'Agent panes sorted by attention rank (blocked, failed, done, working, idle, unknown) then longest-waiting first. No screen content, cwd or env.',
        items: {
          type: 'object',
          properties: {
            paneId: { type: 'string', examples: [PANE_ID_EXAMPLE] },
            hostId: { type: 'string' },
            sessionName: { type: 'string' },
            agent: { type: 'string' },
            agentStatus: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'unknown'] },
            phase: { type: 'string' },
            lastEvent: { type: 'string' },
            task: { type: ['string', 'null'] },
            message: { type: ['string', 'null'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            since: { type: ['string', 'null'] },
            updatedAt: { type: ['string', 'null'] },
            needsHuman: { type: 'boolean', description: 'blocked or failed: a human decision is waiting' },
            self: { type: 'boolean', description: 'Matches the selfPaneId hint from the caller' },
          },
          required: ['paneId', 'hostId', 'sessionName', 'agent', 'agentStatus', 'needsHuman', 'self'],
        },
      },
      truncated: { type: 'boolean' },
    },
    required: ['capturedAt', 'summary', 'panes', 'truncated'],
  },
  'agent.wait': {
    type: 'object',
    properties: {
      waitId: { type: 'string' },
      elapsedMs: { type: 'integer' },
      pane: { type: 'object', description: 'AgentPaneState at the moment the condition was met' },
    },
  },
  'agent.explain': {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      tmuxPaneId: { type: 'string' },
      sessionName: { type: 'string' },
      agent: {
        type: 'object',
        description: 'Detected agent plus which link of the chain produced it',
        properties: {
          name: { type: ['string', 'null'] },
          source: { type: 'string', enum: ['process', 'command', 'screen', 'none'] },
          evidence: { type: 'string', description: 'Static label, never terminal content' },
        },
      },
      state: {
        type: ['object', 'null'],
        description: 'Null when no agent evidence was found',
        properties: {
          agentStatus: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'unknown'] },
          phase: { type: 'string' },
          source: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          message: { type: 'string' },
        },
      },
      screen: {
        type: 'object',
        properties: {
          manifest: {
            type: ['object', 'null'],
            properties: {
              name: { type: 'string' },
              source: { type: 'string', enum: ['bundled', 'override'] },
              version: { type: 'string' },
              file: { type: 'string' },
              ruleCount: { type: 'integer' },
            },
          },
          rule: {
            type: ['object', 'null'],
            properties: {
              id: { type: 'string' },
              priority: { type: 'integer' },
              state: { type: 'string' },
              phase: { type: 'string' },
              region: { type: 'string' },
            },
          },
          miss: { type: 'string', description: 'Why no manifest rule matched' },
        },
      },
      fallback: {
        type: 'object',
        properties: { used: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['used', 'reason'],
      },
      process: {
        type: 'object',
        properties: {
          scanned: { type: 'boolean' },
          agent: { type: ['string', 'null'] },
          command: { type: 'string' },
        },
      },
      capture: {
        type: 'object',
        properties: {
          lines: { type: 'integer' },
          commandRunning: { type: 'boolean' },
          paneDead: { type: 'boolean' },
          osc133: { type: 'string' },
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['paneId', 'agent', 'fallback', 'capturedAt'],
  },
  'agent.start': {
    type: 'object',
    properties: {
      opId: { type: 'string' },
      acked: { type: 'boolean' },
      pane: { type: 'object', description: 'AgentPaneState when acked=true' },
    },
    required: ['opId', 'acked'],
  },
  'agent.prompt': {
    type: 'object',
    properties: { opId: { type: 'string' }, acked: { type: 'boolean' } },
    required: ['opId', 'acked'],
  },
  'agent.cancel': {
    type: 'object',
    properties: {
      opId: { type: 'string' },
      state: { type: 'string', enum: ['cancelled', 'already_settled', 'not_found'] },
    },
    required: ['opId', 'state'],
  },
  push: {
    type: 'object',
    properties: {
      deduplicated: { type: 'boolean' },
      messageId: { type: 'string' },
      assetId: { type: 'string' },
      createdAt: { type: 'string' },
      type: { type: 'string', enum: ['text', 'image', 'video', 'file', 'link'] },
      name: { type: 'string' },
      mime: { type: 'string' },
      size: { type: 'integer' },
      sha256: { type: 'string' },
      route: { type: 'object' },
      revision: { type: 'integer' },
    },
    required: ['messageId', 'createdAt', 'type', 'revision'],
  },
  'open-target': { type: 'object' },
  inbox: { type: 'object' },
  browser: { type: 'object' },
}

interface ControlMethodDef {
  http: 'POST' | 'GET'
  path: string
  params?: z.ZodTypeAny
  // zod 表达不了的线格式约束（如 refine 的跨字段规则），merge 进生成的 params schema
  paramsPatch?: JsonSchema
  errors: string[]
}

export const CONTROL_METHODS: Record<string, ControlMethodDef> = {
  initialize: {
    http: 'POST',
    path: '/initialize',
    params: controlInitializeBodySchema,
    errors: ['AGENT_CONTROL_INITIALIZE_FAILED', 'UNSUPPORTED_PROTOCOL_VERSION'],
  },
  schema: { http: 'GET', path: '/schema', errors: [] },
  'panes.split': {
    http: 'POST',
    path: '/panes/split',
    params: controlSplitBodySchema,
    errors: ['AGENT_CONTROL_SPLIT_FAILED', 'PANE_MISSING', 'PANE_UNKNOWN', 'INVALID_TARGET'],
  },
  'panes.read': {
    http: 'POST',
    path: '/panes/read',
    params: controlReadBodySchema,
    errors: ['AGENT_CONTROL_READ_FAILED', 'PANE_MISSING', 'PANE_UNKNOWN', 'INVALID_TARGET'],
  },
  'panes.snapshot': {
    http: 'POST',
    path: '/panes/snapshot',
    params: controlSnapshotBodySchema,
    errors: [
      'AGENT_CONTROL_SNAPSHOT_FAILED',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_IN_MODE',
      'PANE_UNKNOWN',
      'INVALID_TARGET',
    ],
  },
  'panes.wait-output': {
    http: 'POST',
    path: '/panes/wait-output',
    params: controlWaitOutputBodySchema,
    errors: [
      'AGENT_CONTROL_WAIT_OUTPUT_FAILED',
      'INVALID_PATTERN',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_REMOVED',
      'OCCUPANT_CHANGED',
      'TIMEOUT',
      'PANE_UNKNOWN',
      'INVALID_TARGET',
    ],
  },
  'panes.run': {
    http: 'POST',
    path: '/panes/run',
    params: controlRunBodySchema,
    errors: [
      'AGENT_CONTROL_RUN_FAILED',
      'INVALID_INPUT',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_IN_MODE',
      'PANE_OCCUPIED',
      'PANE_UNKNOWN',
      'INVALID_TARGET',
    ],
  },
  'panes.send-keys': {
    http: 'POST',
    path: '/panes/send-keys',
    params: controlSendKeysBodySchema,
    errors: [
      'AGENT_CONTROL_SEND_KEYS_FAILED',
      'INVALID_KEY',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_IN_MODE',
      'PANE_OCCUPIED',
      'PANE_UNKNOWN',
      'INVALID_TARGET',
    ],
  },
  'panes.task': {
    http: 'POST',
    path: '/panes/task',
    params: controlPaneTaskBodySchema,
    errors: ['AGENT_CONTROL_TASK_FAILED', 'PANE_MISSING', 'PANE_UNKNOWN', 'INVALID_TARGET'],
  },
  'fleet.list': {
    http: 'POST',
    path: '/fleet/list',
    params: controlFleetListBodySchema,
    errors: ['AGENT_CONTROL_FLEET_FAILED'],
  },
  'agent.wait': {
    http: 'POST',
    path: '/agent/wait',
    params: controlWaitBodySchema,
    // condition 的 refine（status/phase/lastEvent 至少其一）zod 内省后丢失，用 anyOf 如实补齐
    paramsPatch: {
      properties: {
        condition: {
          anyOf: [{ required: ['status'] }, { required: ['phase'] }, { required: ['lastEvent'] }],
        },
      },
    },
    errors: ['AGENT_CONTROL_WAIT_FAILED', 'OCCUPANT_CHANGED', 'PANE_REMOVED', 'TIMEOUT', 'INVALID_TARGET'],
  },
  'agent.explain': {
    http: 'POST',
    path: '/agent/explain',
    params: controlExplainBodySchema,
    errors: ['AGENT_CONTROL_EXPLAIN_FAILED', 'PANE_MISSING', 'INVALID_TARGET'],
  },
  'agent.start': {
    http: 'POST',
    path: '/agent/start',
    params: controlAgentStartBodySchema,
    errors: [
      'AGENT_CONTROL_START_FAILED',
      'INVALID_ARGUMENT',
      'PROVIDER_NOT_SUPPORTED',
      'AGENT_CONTROL_SEND_FAILED',
      'AGENT_CONTROL_QUOTA_EXCEEDED',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_IN_MODE',
      'PANE_OCCUPIED',
      'PANE_UNKNOWN',
      'ACK_TIMEOUT',
      'OPERATION_CANCELLED',
      'INVALID_TARGET',
    ],
  },
  'agent.prompt': {
    http: 'POST',
    path: '/agent/prompt',
    params: controlAgentPromptBodySchema,
    errors: [
      'AGENT_CONTROL_PROMPT_FAILED',
      'INVALID_ARGUMENT',
      'AGENT_CONTROL_SEND_FAILED',
      'AGENT_CONTROL_QUOTA_EXCEEDED',
      'PANE_MISSING',
      'PANE_DEAD',
      'PANE_IN_MODE',
      'PANE_NOT_AGENT',
      'PANE_UNKNOWN',
      'ACK_TIMEOUT',
      'OPERATION_CANCELLED',
      'INVALID_TARGET',
    ],
  },
  'agent.cancel': {
    http: 'POST',
    path: '/agent/cancel',
    params: controlAgentCancelBodySchema,
    errors: ['AGENT_CONTROL_CANCEL_FAILED'],
  },
  push: {
    http: 'POST',
    path: '/push',
    params: controlPushBodySchema,
    errors: ['AGENT_PUSH_FAILED', 'INVALID_TARGET'],
  },
  'open-target': {
    http: 'POST',
    path: '/open-target',
    params: controlOpenTargetBodySchema,
    errors: ['AGENT_OPEN_TARGET_FAILED', 'INVALID_TARGET'],
  },
  inbox: {
    http: 'POST',
    path: '/inbox',
    params: controlInboxBodySchema,
    errors: ['AGENT_INBOX_QUERY_FAILED', 'INBOX_MESSAGE_NOT_FOUND'],
  },
  browser: {
    http: 'POST',
    path: '/browser',
    params: controlBrowserBodySchema,
    errors: ['BROWSER_BAD_OP', 'BROWSER_OP_FAILED'],
  },
}

function mergeParamsPatch(generated: JsonSchema, patch: JsonSchema): JsonSchema {
  const out = { ...generated }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'properties' && typeof value === 'object' && value) {
      const props = { ...(out.properties as Record<string, JsonSchema>) }
      for (const [prop, propPatch] of Object.entries(value as Record<string, JsonSchema>)) {
        props[prop] = { ...(props[prop] || {}), ...propPatch }
      }
      out.properties = props
    } else {
      out[key] = value
    }
  }
  return out
}

export interface ControlProtocolSchema {
  [key: string]: unknown
}

// 正式 versioned JSON Schema 文档：method/params/result/错误码/版本/安全限制 一处产出，
// gateway GET /schema、tmuxgo-ctl schema、docs 静态导出共用同一对象
export function buildControlProtocolSchema(): ControlProtocolSchema {
  const methods: Record<string, JsonSchema> = {}
  for (const [name, method] of Object.entries(CONTROL_METHODS)) {
    let params: JsonSchema | undefined
    if (method.params) {
      params = zodToJsonSchema(method.params)
      if (method.paramsPatch) params = mergeParamsPatch(params, method.paramsPatch)
    }
    const successResult = RESULT_SCHEMAS[name] || { type: 'object' }
    methods[name] = {
      http: method.http,
      path: method.path,
      ...(params ? { params } : {}),
      result: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true }, ...(successResult.properties || {}) },
        required: ['ok', ...((successResult.required as string[]) || [])],
      },
      errors: [...new Set([...method.errors, 'AGENT_CONTROL_AUTH_REQUIRED', 'TMUXGO_ENV_GUARD'])],
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `tmuxgo-agent-control/${CONTROL_PROTOCOL_VERSION}`,
    title: 'TmuxGo Agent Control Protocol',
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    supportedVersions: [...SUPPORTED_CONTROL_PROTOCOL_VERSIONS],
    basePath: '/api/v1/control',
    transport: {
      method: 'POST',
      contentType: 'application/json',
      note: 'All methods are POST except schema (GET /schema). Response envelope is a single JSON object.',
    },
    security: {
      headers: {
        'x-tmuxgo-env': { const: '1', description: 'Environment guard; injected by the gateway into agent panes' },
        'x-tmuxgo-agent-token': {
          type: 'string',
          description: 'Same credential as /api/agent-events; never logged or embedded in this document',
        },
      },
      limits: {
        bodyLimitBytes: 65536,
        inFlightOpsPerHost: 8,
        ackTimeoutMs: { minimum: 250, maximum: 30000 },
        waitTimeoutMs: { minimum: 250, maximum: 600000 },
      },
    },
    capabilities: [...CONTROL_CAPABILITIES],
    methods,
    errorCodes: [...CONTROL_ERROR_CODES],
    errorEnvelope: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...CONTROL_ERROR_CODES] },
        message: { type: 'string', description: 'Human-readable only; not part of the contract' },
      },
      required: ['code', 'message'],
    },
  }
}
