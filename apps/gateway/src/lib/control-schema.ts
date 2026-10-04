import type { z } from 'zod'
import {
  CONTROL_CAPABILITIES,
  CONTROL_ERROR_CODES,
  CONTROL_PROTOCOL_VERSION,
  SUPPORTED_CONTROL_PROTOCOL_VERSIONS,
  controlAgentCancelBodySchema,
  controlAgentPromptBodySchema,
  controlAgentStartBodySchema,
  controlBrowserBodySchema,
  controlInboxBodySchema,
  controlOpenTargetBodySchema,
  controlPushBodySchema,
  controlInitializeBodySchema,
  controlReadBodySchema,
  controlRunBodySchema,
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

type ZodDef = {
  typeName: string
  checks?: { kind: string; value?: number; inclusive?: boolean; regex?: RegExp }[]
  values?: string[]
  value?: unknown
  options?: z.ZodTypeAny[]
  innerType?: z.ZodTypeAny
  defaultValue?: () => unknown
  schema?: z.ZodTypeAny
  type?: z.ZodTypeAny
  minLength?: { value: number } | null
  maxLength?: { value: number } | null
  shape?: () => Record<string, z.ZodTypeAny>
}

const def = (schema: z.ZodTypeAny) => schema._def as unknown as ZodDef

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional()
}

// zod → JSON Schema 的最小子集转换；遇未支持类型抛错（测试兜底，防静默产出不完整契约）
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const d = def(schema)
  switch (d.typeName) {
    case 'ZodObject': {
      const shape = d.shape!()
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        if (!isOptional(value)) required.push(key)
      }
      // 服务端 strip 未知字段（兼容约定）——如实声明 additionalProperties:true
      const out: JsonSchema = { type: 'object', properties, additionalProperties: true }
      if (required.length) out.required = required
      return out
    }
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' }
      for (const check of d.checks || []) {
        if (check.kind === 'min') out.minLength = check.value
        else if (check.kind === 'max') out.maxLength = check.value
        else if (check.kind === 'regex') out.pattern = check.regex!.source
        else throw new Error(`zodToJsonSchema: unsupported string check ${check.kind}`)
      }
      return out
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' }
      for (const check of d.checks || []) {
        if (check.kind === 'int') out.type = 'integer'
        else if (check.kind === 'min') out[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value
        else if (check.kind === 'max') out[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value
        else throw new Error(`zodToJsonSchema: unsupported number check ${check.kind}`)
      }
      return out
    }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodLiteral':
      return typeof d.value === 'string' ? { const: d.value } : { const: d.value }
    case 'ZodEnum':
      return { type: 'string', enum: d.values }
    case 'ZodUnion':
      return { anyOf: d.options!.map((option) => zodToJsonSchema(option)) }
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(d.type!) }
      if (d.minLength) out.minItems = d.minLength.value
      if (d.maxLength) out.maxItems = d.maxLength.value
      return out
    }
    case 'ZodOptional':
    case 'ZodEffects':
    case 'ZodReadonly':
      // optional/refine 只影响校验不影响线格式，内层类型即 wire schema
      return zodToJsonSchema((d.innerType || d.schema)!)
    case 'ZodDefault': {
      const out = zodToJsonSchema(d.innerType!)
      out.default = d.defaultValue!()
      return out
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported type ${d.typeName}`)
  }
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
  'agent.wait': {
    type: 'object',
    properties: {
      waitId: { type: 'string' },
      elapsedMs: { type: 'integer' },
      pane: { type: 'object', description: 'AgentPaneState at the moment the condition was met' },
    },
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
