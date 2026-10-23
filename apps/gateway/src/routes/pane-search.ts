import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { assertSessionAllowed } from '../lib/tmux-policy.js'
import { parseSessionRef } from '../lib/tmux-target.js'
import { getRequestPrincipal } from '../lib/principal.js'
import { resolvePrincipalScope, scopeAllowsSession } from '../lib/access-scope.js'
import { PANE_SEARCH_DEFAULT_LINES, PANE_SEARCH_MAX_LINES, searchSessionPanes } from '../lib/pane-search.js'

// 只读搜索：query 走 body（POST）或 query string（GET），GET 变体是给 readOnly scope
// 的 token 留的口子——accessScopeGuard 只放行 GET/HEAD 给只读身份，搜索引擎本身无副作用
const paneSearchSchema = z.object({
  query: z.string().min(1).max(200),
  mode: z.enum(['literal', 'regex']).optional(),
  lines: z.number().int().min(1).max(PANE_SEARCH_MAX_LINES).optional(),
})

function errorMessage(error: unknown, fallback = 'pane search failed') {
  return error instanceof Error && error.message ? error.message : fallback
}

export async function paneSearchRoutes(fastify: FastifyInstance) {
  const handler = async (request: { params: unknown; body: unknown; query: unknown }, reply: FastifyReply) => {
    const params = request.params as { hostId: string; sessionId: string }
    // GET 变体把参数放 query string：合并后再校验，两条路径共用一份逻辑
    const raw = { ...(request.query as Record<string, unknown>), ...(request.body as Record<string, unknown>) }
    const parsed = paneSearchSchema.safeParse({
      query: typeof raw.query === 'string' ? raw.query : undefined,
      mode: raw.mode === 'regex' ? 'regex' : raw.mode === 'literal' ? 'literal' : undefined,
      lines: raw.lines === undefined || raw.lines === '' ? undefined : Number(raw.lines),
    })
    // 显式 400：非法参数（空 query、越界深度）不能被当成「搜到了 0 条」糊过去
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid query' })
    try {
      const { hostId, sessionName } = parseSessionRef(params.hostId, params.sessionId)
      // allowlist（TMUX_WEB_ALLOWED_SESSIONS）之外一律拒：与其它 session 路由同一条防线
      assertSessionAllowed(sessionName)
      const principal = getRequestPrincipal(request as never)
      // 分享链接的观看者只有 WS 票据、没有 HTTP 身份；这里再挡一道，防止将来把搜索
      // 端点接进分享视图（分享视图看的是别人会话的历史内容）
      if (principal.source === 'share') return { ok: false, error: 'forbidden' }
      const scope = resolvePrincipalScope(principal)
      // 受限用户：session 不在 allowlist 内直接拒。panes 全部取自这唯一 session，
      // 因此 session 级判定即为 pane 级判定（与 stream 的 drop 点同一口径）
      if (scope && !scopeAllowsSession(scope, hostId, sessionName)) return { ok: false, error: 'forbidden' }
      const result = await searchSessionPanes({
        hostId,
        sessionName,
        query: parsed.data.query,
        mode: parsed.data.mode,
        lines: parsed.data.lines ?? PANE_SEARCH_DEFAULT_LINES,
      })
      return result
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
  fastify.route({
    method: ['POST', 'GET'],
    url: '/hosts/:hostId/sessions/:sessionId/pane-search',
    handler: handler as never,
  })
}
