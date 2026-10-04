import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import {
  collectScopeTargets,
  createScopedApiToken,
  listScopedApiTokens,
  revokeScopedApiToken,
  scopeAllowsHost,
  scopeAllowsSession,
  scopeDenyReason,
  scopeIsRestricted,
  subjectScope,
  verifyScopedApiToken,
} from './access-scope.js'
import { describeScope } from './principal.js'

function fakeRequest(input: {
  url?: string
  routeUrl?: string
  method?: string
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}) {
  const url = input.url || '/api/probe'
  return {
    url,
    method: input.method || 'GET',
    params: input.params || {},
    query: input.query || {},
    body: input.body,
    routeOptions: { url: input.routeUrl || url },
    headers: {},
  } as never
}

test('scoped api tokens: create/verify/list/revoke and expiry', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-scope-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  const { token, record } = createScopedApiToken({
    name: 'ci',
    scope: { hosts: ['local'], sessions: ['main'] },
  })
  assert.equal(record.name, 'ci')
  assert.equal('tokenHash' in record, false)
  assert.ok(token.startsWith('tgk_'))
  assert.deepEqual(verifyScopedApiToken(token), { name: 'ci', scope: { hosts: ['local'], sessions: ['main'] } })
  assert.equal(verifyScopedApiToken('tgk_wrong'), null)
  assert.equal(verifyScopedApiToken('opaque-session-token'), null)
  const listed = listScopedApiTokens()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, record.id)
  assert.equal('tokenHash' in listed[0], false)
  const expired = createScopedApiToken({
    name: 'old',
    scope: { hosts: '*' },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  })
  assert.equal(verifyScopedApiToken(expired.token), null)
  assert.equal(revokeScopedApiToken(record.id), true)
  assert.equal(verifyScopedApiToken(token), null)
  assert.equal(revokeScopedApiToken('missing'), false)
  assert.throws(() => createScopedApiToken({ name: 'x', scope: { hosts: [] } }))
  assert.throws(() => createScopedApiToken({ name: 'x', scope: 'nope' }))
})

test('subject scope overrides live in access-scopes.json', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-scope-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  assert.equal(subjectScope('agent'), undefined)
  await writeFile(
    path.join(configDir, 'access-scopes.json'),
    `${JSON.stringify({
      version: 1,
      subjects: {
        agent: { hosts: ['runner-1'] },
        'user:admin': { hosts: ['local'], readOnly: true },
        'bad-entry': { hosts: [] },
      },
    })}\n`,
  )
  assert.deepEqual(subjectScope('agent'), { hosts: ['runner-1'] })
  assert.deepEqual(subjectScope('user:admin'), { hosts: ['local'], readOnly: true })
  assert.equal(subjectScope('bad-entry'), undefined)
  assert.equal(subjectScope('user:other'), undefined)
})

test('scope predicates', () => {
  assert.equal(scopeIsRestricted(undefined), false)
  assert.equal(scopeIsRestricted({ hosts: '*' }), false)
  assert.equal(scopeIsRestricted({ hosts: ['local'] }), true)
  assert.equal(scopeIsRestricted({ hosts: '*', readOnly: true }), true)
  assert.equal(scopeIsRestricted({ hosts: '*', sessions: ['s1'] }), true)
  assert.equal(scopeAllowsHost({ hosts: ['a'] }, 'a'), true)
  assert.equal(scopeAllowsHost({ hosts: ['a'] }, 'b'), false)
  assert.equal(scopeAllowsSession({ hosts: ['a'], sessions: ['s1'] }, 'a', 's1'), true)
  assert.equal(scopeAllowsSession({ hosts: ['a'], sessions: ['s1'] }, 'a', 's2'), false)
  assert.equal(scopeAllowsSession({ hosts: ['a'], sessions: ['s1'] }, 'b', 's1'), false)
  assert.equal(scopeAllowsSession({ hosts: ['a'] }, 'a', 'anything'), true)
  assert.equal(describeScope({ hosts: ['a', 'b'], sessions: ['s1'], readOnly: true }), 'hosts=a,b;sessions=s1;ro')
})

test('collectScopeTargets resolves hosts and sessions from params/query/body', () => {
  const from = (input: Parameters<typeof fakeRequest>[0]) => collectScopeTargets(fakeRequest(input))
  let targets = from({
    routeUrl: '/api/hosts/:hostId/sessions/:sessionId',
    url: '/api/hosts/h1/sessions/session-h1-main',
    method: 'DELETE',
    params: { hostId: 'h1', sessionId: 'session-h1-main' },
  })
  assert.deepEqual([...targets.hosts], ['h1'])
  assert.deepEqual([...targets.sessions.get('h1')!], ['main'])
  targets = from({
    routeUrl: '/api/panes/select',
    url: '/api/panes/select',
    method: 'POST',
    body: { paneId: 'h2:%3' },
  })
  assert.deepEqual([...targets.hosts], ['h2'])
  targets = from({
    routeUrl: '/api/hosts/:id',
    url: '/api/hosts/h3',
    params: { id: 'h3' },
  })
  assert.deepEqual([...targets.hosts], ['h3'])
  targets = from({
    routeUrl: '/api/hosts/:hostId/sessions/batch-delete',
    url: '/api/hosts/h1/sessions/batch-delete',
    method: 'POST',
    params: { hostId: 'h1' },
    body: { sessionIds: ['session-h1-a', 'session-h1-b'] },
  })
  assert.deepEqual([...targets.sessions.get('h1')!], ['a', 'b'])
  targets = from({
    routeUrl: '/api/hosts/:hostId/sessions',
    url: '/api/hosts/h1/sessions',
    method: 'POST',
    params: { hostId: 'h1' },
    body: { name: 'fresh' },
  })
  assert.deepEqual([...targets.sessions.get('h1')!], ['fresh'])
  targets = from({
    routeUrl: '/api/v1/control/agent/wait',
    url: '/api/v1/control/agent/wait',
    method: 'POST',
    body: { target: { sessionName: 'dev', agent: 'claude' }, hostId: 'h9' },
  })
  assert.deepEqual([...targets.hosts], ['h9'])
  assert.deepEqual([...targets.sessions.get('h9')!], ['dev'])
  // paneIds 批量体（/panes/mark-seen）：每个 id 单独解出 host，畸形项跳过
  targets = from({
    routeUrl: '/api/panes/mark-seen',
    url: '/api/panes/mark-seen',
    method: 'POST',
    body: { paneIds: ['h2:%3', 'h5:%1', 'bad'] },
  })
  assert.deepEqual([...targets.hosts].sort(), ['h2', 'h5'])
  // window/pane 复合 id 提取 host；畸形 id 静默跳过交给路由自身校验
  targets = from({
    routeUrl: '/api/windows/:windowId/panes',
    url: '/api/windows/h7:@2/panes',
    params: { windowId: 'h7:@2' },
    body: { paneId: 'not-a-pane' },
  })
  assert.deepEqual([...targets.hosts], ['h7'])
})

test('scopeDenyReason: admin-only, readOnly, host/session 越界与放行', () => {
  const scope = { hosts: ['local'], sessions: ['s1'], readOnly: false }
  assert.equal(
    scopeDenyReason(scope, fakeRequest({ url: '/api/audit-log', routeUrl: '/api/audit-log' }))?.reason,
    'admin-only',
  )
  assert.equal(
    scopeDenyReason(scope, fakeRequest({ url: '/api/hosts', routeUrl: '/api/hosts', method: 'POST' }))?.reason,
    'admin-only',
  )
  assert.equal(
    scopeDenyReason(scope, fakeRequest({ url: '/api/hosts/h9/vnc/password', routeUrl: '/api/hosts/:id/vnc/password' }))
      ?.reason,
    'admin-only',
  )
  // 受限只读身份连允许的 host 上的写操作也拒绝
  assert.equal(
    scopeDenyReason(
      { hosts: ['local'], readOnly: true },
      fakeRequest({
        url: '/api/hosts/local/sessions',
        routeUrl: '/api/hosts/:hostId/sessions',
        method: 'POST',
        params: { hostId: 'local' },
        body: { name: 's1' },
      }),
    )?.reason,
    'read-only',
  )
  assert.equal(
    scopeDenyReason(
      scope,
      fakeRequest({
        url: '/api/hosts/h9/sessions',
        routeUrl: '/api/hosts/:hostId/sessions',
        params: { hostId: 'h9' },
      }),
    )?.reason,
    'host',
  )
  assert.equal(
    scopeDenyReason(
      scope,
      fakeRequest({
        url: '/api/hosts/local/sessions/session-local-s2/layout',
        routeUrl: '/api/hosts/:hostId/sessions/:sessionId/layout',
        params: { hostId: 'local', sessionId: 'session-local-s2' },
      }),
    )?.reason,
    'session',
  )
  assert.equal(
    scopeDenyReason(
      scope,
      fakeRequest({
        url: '/api/hosts/local/sessions/session-local-s1/layout',
        routeUrl: '/api/hosts/:hostId/sessions/:sessionId/layout',
        params: { hostId: 'local', sessionId: 'session-local-s1' },
      }),
    ),
    null,
  )
  // 非 /api 公开路径与全权身份不拦截
  assert.equal(scopeDenyReason(scope, fakeRequest({ url: '/s/i/abc', routeUrl: '/s/i/:token' })), null)
  assert.equal(scopeDenyReason(undefined, fakeRequest({ url: '/api/audit-log', routeUrl: '/api/audit-log' })), null)
})
