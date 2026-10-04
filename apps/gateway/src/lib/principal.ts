import type { FastifyRequest } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from './agent-events.js'

// 全站请求身份（principal）唯一来源：
//   - authenticated HTTP：index.ts auth hook 调 auth.ts 的 authenticateHttpRequest 写入 request.principal
//   - agent 控制面/事件路由：自带 token guard，审计时按请求头惰性识别（agent-token）
//   - 公开路由（login/share exchange/health 等）：保持 anonymous，不再伪造 local
//   - ssh-attach / ws connect：各自入口直接写 AuditEvent.source
// 注意：本模块刻意不 import auth.js——audit-log → 本模块 的链路在测试里会在
// test-env 就绪前求值 auth 模块级 env，必须保持轻依赖
export type AuditSource = 'http' | 'agent-token' | 'ws' | 'ssh' | 'share' | 'anonymous'
export interface RequestPrincipal {
  actor: string
  source: AuditSource
  sessionId?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: RequestPrincipal
  }
}

export function markRequestPrincipal(request: FastifyRequest, principal: RequestPrincipal) {
  request.principal = principal
}

// 审计/日志统一取身份：已标记直接用；否则识别 agent 专用 token；再否则匿名。
// agent token 只在请求确实携带凭证时才校验，避免对纯匿名请求无谓地解析/生成 token
export function getRequestPrincipal(request: FastifyRequest): RequestPrincipal {
  if (request.principal?.actor) return request.principal
  const candidate = getAgentEventToken(request.headers)
  if (candidate && isAgentEventToken(candidate)) return { actor: 'agent', source: 'agent-token' }
  return { actor: 'anonymous', source: 'anonymous' }
}
