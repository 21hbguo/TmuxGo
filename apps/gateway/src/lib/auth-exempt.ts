// 认证豁免清单：命中即跳过 HTTP 认证 hook。写错 = 对外裸奔，所以清单、前缀规则和
// 判定逻辑集中在这里，并由 auth-exempt.test.ts 逐条覆盖（新增端点必须同时进清单和用例）。

// 非 /api/ 前缀（静态资源、/health、/s/i/:token 分享下载）整体不参与认证判定，
// 它们各自的访问控制由路由自己负责
const API_PREFIX = '/api/'

export const AUTH_EXEMPT_PATHS = [
  '/api/stream',
  '/api/vnc',
  '/api/browser/stream',
  '/api/agent-events',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/shares/exchange',
] as const

// 控制面端点全部自带 agent token + x-tmuxgo-env 双守卫（agent-control/agent-push/browser），
// 按前缀豁免用户认证——逐路径列名会在新增端点时漏配，agent token 在到达路由守卫前被 401
export const AUTH_EXEMPT_PREFIXES = ['/api/v1/control/'] as const

const EXEMPT_PATH_SET = new Set<string>(AUTH_EXEMPT_PATHS)

// routePath 必须是已剥离 query 的路径（调用方负责 request.url.split('?')[0]）
export function isAuthExemptPath(routePath: string) {
  if (!routePath.startsWith(API_PREFIX)) return true
  if (EXEMPT_PATH_SET.has(routePath)) return true
  return AUTH_EXEMPT_PREFIXES.some((prefix) => routePath.startsWith(prefix))
}
