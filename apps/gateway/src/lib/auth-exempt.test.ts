import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTH_EXEMPT_PATHS, AUTH_EXEMPT_PREFIXES, isAuthExemptPath } from './auth-exempt.js'

// 独立的一份字面清单（不从实现里读）：删条目、加条目、改路径都必须让用例红
const EXPECTED_EXEMPT = [
  '/api/stream',
  '/api/vnc',
  '/api/browser/stream',
  '/api/agent-events',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/shares/exchange',
]

test('keeps the auth exemption inventory explicit', () => {
  // 清单即契约：新增/删除豁免端点必须同步改这里，否则用例红——防止悄悄开口子
  assert.deepEqual([...AUTH_EXEMPT_PATHS], EXPECTED_EXEMPT)
  assert.deepEqual([...AUTH_EXEMPT_PREFIXES], ['/api/v1/control/'])
})

test('exempts every whitelisted path', () => {
  for (const routePath of EXPECTED_EXEMPT) assert.equal(isAuthExemptPath(routePath), true, routePath)
})

test('exempts non-api paths wholesale', () => {
  // 静态资源、/health、/s/i/:token 分享下载不带 /api 前缀，认证 hook 整体不参与
  for (const routePath of ['/', '/health', '/sw.js', '/assets/index-abc.js', '/s/i/token123'])
    assert.equal(isAuthExemptPath(routePath), true, routePath)
})

test('exempts the control-plane prefix only with the trailing slash', () => {
  assert.equal(isAuthExemptPath('/api/v1/control/agents'), true)
  assert.equal(isAuthExemptPath('/api/v1/control/browser/tabs'), true)
  // 少斜杠或多字母都落到认证路径上，避免 /api/v1/controlX 被前缀匹配蹭豁免
  assert.equal(isAuthExemptPath('/api/v1/control'), false)
  assert.equal(isAuthExemptPath('/api/v1/controlX/agents'), false)
})

test('requires authentication for ordinary api routes', () => {
  for (const routePath of [
    '/api/hosts',
    '/api/sessions/local:dev',
    '/api/streams',
    '/api/auth/loginx',
    '/api/auth/change-password',
    '/api/shares/exchange/extra',
    '/api/agent-events/1',
  ])
    assert.equal(isAuthExemptPath(routePath), false, routePath)
})

test('does not exempt a query string appended to a protected route', () => {
  // 调用方先剥离 query 再判定；未剥离时按普通路径处理，宁可多要一次认证
  assert.equal(isAuthExemptPath('/api/auth/status?probe=1'), false)
})
