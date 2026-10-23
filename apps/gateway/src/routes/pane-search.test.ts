import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { execTmuxFile, killTestTmuxSession, sendTmuxKeys, TEST_TMUX_SESSION } from '../test-tmux.js'
import { paneSearchRoutes } from './pane-search.js'
import { clearPaneSearchCache, paneSearchInflightSize, searchSessionPanes } from '../lib/pane-search.js'
import type { AccessScope } from '../lib/access-scope.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）

async function captureText(target: string) {
  const { stdout } = await execTmuxFile('tmux', ['capture-pane', '-p', '-S', '-', '-t', target])
  return stdout
}

// tmux 收键到 shell 回显出文本有延迟，轮询到出现为止（最多 3s）
async function waitForText(target: string, needle: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await captureText(target)).includes(needle)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${needle} in ${target}`)
}

async function createTwoPaneSession() {
  await execTmuxFile('tmux', ['new-session', '-d', '-s', TEST_TMUX_SESSION, '-x', '100', '-y', '30'])
  await execTmuxFile('tmux', ['split-window', '-t', TEST_TMUX_SESSION, '-h'])
  const { stdout } = await execTmuxFile('tmux', ['list-panes', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
  return stdout.trim().split('\n').filter(Boolean)
}

function buildFastify(scope?: AccessScope) {
  const fastify = Fastify()
  if (scope) {
    // 路由内还有一层 scope 过滤（全局 accessScopeGuard 之外的自检），
    // 这里直接注入受限身份来验证那一层
    fastify.addHook('onRequest', async (request) => {
      request.principal = { actor: 'token:test', source: 'http', scope }
    })
  }
  fastify.register(paneSearchRoutes)
  return fastify
}

test('finds hits across panes with paneId and line numbers', async () => {
  clearPaneSearchCache()
  const [pane0, pane1] = await createTwoPaneSession()
  const fastify = buildFastify()
  try {
    await sendTmuxKeys(pane0, 'printf "PANESEARCH_ALPHA one\\n"', 'Enter')
    await sendTmuxKeys(pane1, 'printf "PANESEARCH_ALPHA two\\n"', 'Enter')
    await waitForText(pane0, 'PANESEARCH_ALPHA one')
    await waitForText(pane1, 'PANESEARCH_ALPHA two')
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: 'PANESEARCH_ALPHA' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as {
      ok: boolean
      hits: { paneId: string; line: number; lineFromEnd: number; preview: string }[]
      panes: { paneId: string; capturedLines: number }[]
    }
    assert.equal(body.ok, true)
    assert.equal(body.panes.length, 2)
    const panesWithHits = new Set(body.hits.map((hit) => hit.paneId))
    assert.ok(panesWithHits.has(`local:${pane0}`), 'pane0 hit missing')
    assert.ok(panesWithHits.has(`local:${pane1}`), 'pane1 hit missing')
    const capturedByPane = new Map(body.panes.map((pane) => [pane.paneId, pane.capturedLines]))
    for (const hit of body.hits) {
      assert.match(hit.preview, /PANESEARCH_ALPHA/)
      assert.ok(hit.line >= 1)
      // line（1 起，从缓冲区头）与 lineFromEnd（从末尾倒数）必须互补
      assert.equal(hit.line + hit.lineFromEnd, (capturedByPane.get(hit.paneId) || 0) + 1)
    }
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('honors the lines depth parameter and caps it', async () => {
  clearPaneSearchCache()
  await createTwoPaneSession()
  const fastify = buildFastify()
  try {
    const shallow = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: 'zzz_no_such_token', lines: 50 },
    })
    const shallowBody = shallow.json() as { ok: boolean; maxLines: number; panes: { capturedLines: number }[] }
    assert.equal(shallowBody.ok, true)
    assert.equal(shallowBody.maxLines, 50)
    // capture-pane 深度按「目标行数 - 视口高度」换算，误差容 2 行（尾部空行/换行）
    for (const pane of shallowBody.panes) assert.ok(pane.capturedLines <= 52, 'capture depth not limited')
    const capped = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: 'zzz_no_such_token', lines: 999999 },
    })
    // zod 上限 5000 先行拒绝，越界请求不会退化成「抓全量」
    assert.equal(capped.statusCode, 400)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('restricted scope cannot search a session outside its allowlist', async () => {
  await createTwoPaneSession()
  const fastify = buildFastify({ hosts: '*', sessions: ['someone-else'], readOnly: true })
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: 'anything' },
    })
    const body = response.json() as { ok: boolean; error?: string }
    assert.equal(body.ok, false)
    assert.equal(body.error, 'forbidden')
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('serves the same search over GET for read-only tokens', async () => {
  clearPaneSearchCache()
  const [pane0] = await createTwoPaneSession()
  const fastify = buildFastify({ hosts: '*', sessions: '*', readOnly: true })
  try {
    await sendTmuxKeys(pane0, 'printf "PANESEARCH_GET token\\n"', 'Enter')
    await waitForText(pane0, 'PANESEARCH_GET token')
    // accessScopeGuard 对只读身份只放行 GET/HEAD；搜索本身无副作用，因此留了 GET 变体
    const response = await fastify.inject({
      method: 'GET',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search?query=PANESEARCH_GET&lines=200`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { ok: boolean; hits: { preview: string }[]; maxLines: number }
    assert.equal(body.ok, true)
    assert.equal(body.maxLines, 200)
    assert.ok(body.hits.some((hit) => hit.preview.includes('PANESEARCH_GET')))
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('accepts the session-<host>-<name> id form used by the frontend', async () => {
  clearPaneSearchCache()
  const [pane0] = await createTwoPaneSession()
  const fastify = buildFastify()
  try {
    await sendTmuxKeys(pane0, 'printf "PANESEARCH_IDFORM x\\n"', 'Enter')
    await waitForText(pane0, 'PANESEARCH_IDFORM x')
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/session-local-${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: 'PANESEARCH_IDFORM' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { ok: boolean; hits: { paneId: string }[] }
    assert.equal(body.ok, true)
    assert.ok(body.hits.length >= 1)
    assert.equal(body.hits[0].paneId, `local:${pane0}`)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('rejects empty queries instead of scanning everything', async () => {
  await createTwoPaneSession()
  const fastify = buildFastify()
  try {
    const response = await fastify.inject({
      method: 'POST',
      url: `/hosts/local/sessions/${TEST_TMUX_SESSION}/pane-search`,
      payload: { query: '' },
    })
    assert.equal((response.json() as { ok: boolean }).ok, false)
  } finally {
    await fastify.close()
    await killTestTmuxSession()
  }
})

test('dedupes identical searches and reuses the capture cache', async () => {
  clearPaneSearchCache()
  const [pane0] = await createTwoPaneSession()
  try {
    await sendTmuxKeys(pane0, 'printf "PANESEARCH_CACHE hit\\n"', 'Enter')
    await waitForText(pane0, 'PANESEARCH_CACHE hit')
    const options = { hostId: 'local', sessionName: TEST_TMUX_SESSION, query: 'PANESEARCH_CACHE', lines: 200 }
    const [first, second] = await Promise.all([searchSessionPanes(options), searchSessionPanes(options)])
    // 同请求 in-flight 复用：两次调用拿到同一份结果对象
    assert.equal(first, second)
    assert.equal(paneSearchInflightSize(), 0)
    assert.ok(first.hits.length >= 1)
    const third = await searchSessionPanes(options)
    assert.equal(
      third.panes.every((pane) => pane.cached),
      true,
      'second round should hit the capture cache',
    )
  } finally {
    await killTestTmuxSession()
  }
})
