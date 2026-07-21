import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

test('links, runs, stores and removes a plugin', async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-test-'))
  process.env.TMUXGO_CONFIG_DIR = configRoot
  const pluginRoot = path.join(configRoot, 'fixture')
  await mkdir(path.join(pluginRoot, 'ui'), { recursive: true })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.fixture', name: 'Test Fixture', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'echo-context', title: 'Echo Context', command: [process.execPath, 'action.mjs'] }], views: [{ id: 'main', title: 'Fixture', entry: 'ui/index.html', placement: 'activity' }] } }))
  await writeFile(path.join(pluginRoot, 'action.mjs'), "process.stdout.write(JSON.parse(process.env.TMUXGO_CONTEXT_JSON).hostId)")
  await writeFile(path.join(pluginRoot, 'ui', 'index.html'), '<!doctype html><script src="/api/plugins/runtime.js"></script><div>fixture</div>')
  const { pluginRoutes } = await import('../apps/gateway/src/routes/plugins.ts')
  const app = Fastify()
  await app.register(pluginRoutes, { prefix: '/api' })
  const linked = await app.inject({ method: 'POST', url: '/api/plugins/link', payload: { path: pluginRoot } })
  assert.equal(linked.statusCode, 200)
  assert.equal(linked.json().pluginId, 'test.fixture')
  const list = await app.inject({ method: 'GET', url: '/api/plugins' })
  assert.equal(list.json().plugins.length, 1)
  const invoked = await app.inject({ method: 'POST', url: '/api/plugins/test.fixture/actions/echo-context/invoke', payload: { context: { hostId: 'local' } } })
  assert.equal(invoked.statusCode, 200)
  assert.equal(invoked.json().status, 'success')
  assert.equal(invoked.json().stdout, 'local')
  const stored = await app.inject({ method: 'PUT', url: '/api/plugins/test.fixture/storage/config', payload: { value: { enabled: true } } })
  assert.equal(stored.statusCode, 200)
  const value = await app.inject({ method: 'GET', url: '/api/plugins/test.fixture/storage/config' })
  assert.deepEqual(value.json().value, { enabled: true })
  const asset = await app.inject({ method: 'GET', url: '/api/plugins/test.fixture/assets/ui/index.html' })
  assert.equal(asset.statusCode, 200)
  assert.match(asset.headers['content-security-policy'] || '', /connect-src 'none'/)
  const disabled = await app.inject({ method: 'PATCH', url: '/api/plugins/test.fixture/enabled', payload: { enabled: false } })
  assert.equal(disabled.json().state, 'disabled')
  const blocked = await app.inject({ method: 'POST', url: '/api/plugins/test.fixture/actions/echo-context/invoke', payload: { context: {} } })
  assert.equal(blocked.statusCode, 400)
  const removed = await app.inject({ method: 'DELETE', url: '/api/plugins/test.fixture' })
  assert.equal(removed.statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins' })).json().plugins.length, 0)
  await app.close()
})

test('rejects invalid and duplicate manifest contributions', async () => {
  const { parsePluginManifest } = await import('../apps/gateway/src/lib/plugin-manifest.ts')
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  assert.throws(() => parsePluginManifest({ schemaVersion: 1, id: '../bad', name: 'Bad', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform] }))
  assert.throws(() => parsePluginManifest({ schemaVersion: 1, id: 'test.duplicate', name: 'Duplicate', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'run', title: 'Run', command: ['true'] }, { id: 'run', title: 'Run again', command: ['true'] }] } }))
})
