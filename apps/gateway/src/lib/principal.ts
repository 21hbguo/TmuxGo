import type { FastifyRequest } from 'fastify'
import { getAgentEventToken, isAgentEventToken } from './agent-events.js'
import type { AccessScope } from './access-scope.js'

// 全站请求身份（principal）唯一来源：
//   - authenticated HTTP：index.ts auth hook 调 auth.ts 的 authenticateHttpRequest 写入 request.principal
//   - agent 控制面/事件路由：自带 token guard，审计时按请求头惰性识别（agent-token）
//   - 公开路由（login/share exchange/health 等）：保持 anonymous，不再伪造 local
//   - ssh-attach / ws connect：各自入口直接写 AuditEvent.source
// scope 为 host/session 最小权限（access-scope.ts）：缺省 = 全权，保持单用户兼容。
// 注意：本模块刻意不 import auth.js——audit-log → 本模块 的链路在测试里会在
// test-env 就绪前求值 auth 模块级 env，必须保持轻依赖（AccessScope 仅类型引用，零运行时成本）
export type AuditSource = 'http' | 'agent-token' | 'ws' | 'ssh' | 'share' | 'anonymous'
export interface RequestPrincipal {
  actor: string
  source: AuditSource
  sessionId?: string
  scope?: AccessScope
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: RequestPrincipal
  }
}

export function markRequestPrincipal(request: FastifyRequest, principal: RequestPrincipal) {
  request.principal = principal
}
// scope 摘要进审计：可核对判定依据，不回写任何凭证材料
export function describeScope(scope: AccessScope) {
  const hosts = scope.hosts === '*' ? '*' : scope.hosts.join(',')
  const sessions =
    scope.sessions === undefined ? '' : `;sessions=${scope.sessions === '*' ? '*' : scope.sessions.join(',')}`
  return `hosts=${hosts}${sessions}${scope.readOnly ? ';ro' : ''}`.slice(0, 256)
}

// 审计/日志统一取身份：已标记直接用；否则识别 agent 专用 token；再否则匿名。
// agent token 只在请求确实携带凭证时才校验，避免对纯匿名请求无谓地解析/生成 token
export function getRequestPrincipal(request: FastifyRequest): RequestPrincipal {
  if (request.principal?.actor) return request.principal
  const candidate = getAgentEventToken(request.headers)
  if (candidate && isAgentEventToken(candidate)) return { actor: 'agent', source: 'agent-token' }
  return { actor: 'anonymous', source: 'anonymous' }
}
