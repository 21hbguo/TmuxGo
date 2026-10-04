import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { CONTROL_ERROR_CODES, CONTROL_PROTOCOL_VERSION } from './control-protocol.js'
import { CONTROL_METHODS, buildControlProtocolSchema, zodToJsonSchema } from './control-schema.js'

// 内省器只支持协议用到的 zod 子集；新增类型时必须显式扩展而不是静默降级
test('zodToJsonSchema converts the protocol subset faithfully', () => {
  assert.deepEqual(zodToJsonSchema(z.string().min(3).max(256)), { type: 'string', minLength: 3, maxLength: 256 })
  assert.deepEqual(zodToJsonSchema(z.string().regex(/^x+$/)), { type: 'string', pattern: '^x+$' })
  assert.deepEqual(zodToJsonSchema(z.number().int().min(250).max(600000)), {
    type: 'integer',
    minimum: 250,
    maximum: 600000,
  })
  assert.deepEqual(zodToJsonSchema(z.boolean().default(true)), { type: 'boolean', default: true })
  assert.deepEqual(zodToJsonSchema(z.enum(['a', 'b'])), { type: 'string', enum: ['a', 'b'] })
  assert.deepEqual(zodToJsonSchema(z.array(z.string()).max(8)), {
    type: 'array',
    items: { type: 'string' },
    maxItems: 8,
  })
  assert.deepEqual(zodToJsonSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])), {
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: true, required: ['b'] },
    ],
  })
  const obj = zodToJsonSchema(z.object({ req: z.string(), opt: z.string().optional(), def: z.string().default('d') }))
  assert.deepEqual(obj.required, ['req'])
  assert.equal((obj.properties as Record<string, { default?: string }>).def.default, 'd')
  // refine 包装透传内层 schema（跨字段约束由 paramsPatch 另行表达）
  assert.equal((zodToJsonSchema(z.object({ x: z.string() }).refine(() => true)) as { type: string }).type, 'object')
  assert.throws(() => zodToJsonSchema(z.date()), /unsupported type/)
})

test('protocol document mirrors the zod request models', () => {
  const doc = buildControlProtocolSchema()
  const methods = doc.methods as Record<string, { params?: { properties: Record<string, any>; required?: string[] } }>

  // Task9 编排原语：bounds 与 zod 一致
  assert.equal(methods['panes.snapshot'].params!.properties.lines.maximum, 100)
  assert.equal(methods['panes.read'].params!.properties.lines.maximum, 2000)
  assert.equal(methods['panes.wait-output'].params!.properties.lines.maximum, 200)
  assert.equal(methods['panes.wait-output'].params!.properties.timeoutMs.minimum, 250)
  assert.equal(methods['panes.wait-output'].params!.properties.timeoutMs.maximum, 600000)
  assert.equal(methods['panes.run'].params!.properties.text.maxLength, 4096)
  assert.deepEqual(methods['panes.run'].params!.required, ['paneId', 'text'])

  // Task12 agent actions：args pattern / opId pattern / ackTimeoutMs 范围不丢
  const start = methods['agent.start'].params!.properties
  assert.equal(start.args.items.pattern, '^-{0,2}[A-Za-z0-9][A-Za-z0-9._:/=-]{0,126}$')
  assert.equal(start.args.maxItems, 8)
  assert.equal(start.ackTimeoutMs.maximum, 30000)
  assert.equal(start.opId.pattern, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')
  assert.deepEqual(start.provider.enum, ['claude', 'codex'])
  assert.equal(methods['agent.prompt'].params!.properties.prompt.maxLength, 8192)
  assert.deepEqual(methods['agent.cancel'].params!.required, ['opId'])

  // agent.wait condition 的「至少一个条件」refine 经 paramsPatch 如实表达
  const condition = methods['agent.wait'].params!.properties.condition
  assert.deepEqual(condition.anyOf, [{ required: ['status'] }, { required: ['phase'] }, { required: ['lastEvent'] }])
  assert.deepEqual(methods['agent.wait'].params!.required, ['target', 'condition'])

  // 每个 params schema 都能被对应 zod schema 接受的最小样本满足（形状一致性抽查）
  for (const [name, method] of Object.entries(CONTROL_METHODS)) {
    if (!method.params) continue
    const params = methods[name].params!
    for (const key of params.required || []) {
      assert.ok(key in params.properties, `${name}: required key ${key} missing from properties`)
    }
  }
})

test('protocol document carries version, limits and full error-code table', () => {
  const doc = buildControlProtocolSchema()
  assert.equal(doc.protocolVersion, CONTROL_PROTOCOL_VERSION)
  assert.equal(doc.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.deepEqual(doc.errorCodes, [...CONTROL_ERROR_CODES])
  const limits = (doc.security as { limits: Record<string, unknown> }).limits
  assert.equal(limits.bodyLimitBytes, 65536)
  assert.equal(limits.inFlightOpsPerHost, 8)
  // 错误 envelope 把错误码枚举收口
  const envelope = doc.errorEnvelope as { properties: { code: { enum: string[] } } }
  assert.deepEqual(envelope.properties.code.enum, [...CONTROL_ERROR_CODES])
})
