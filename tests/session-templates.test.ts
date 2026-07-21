import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { templateRoutes } from '../apps/gateway/src/routes/templates'

test('persists and normalizes session templates', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-templates-'))
  process.env.TMUXGO_CONFIG_DIR = configDir
  const app = Fastify()
  await app.register(templateRoutes, { prefix: '/api' })
  t.after(async () => {
    await app.close()
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const response = await app.inject({ method: 'PUT', url: '/api/session-templates', payload: { templates: [{ id: 'dev-template', name: ' Dev Template ', description: ' workspace ', layout: { windows: [{ name: ' editor ', splitDirection: 'vertical', layoutPreset: 'main-vertical', panes: [{ command: ' npm run dev ', cwd: ' /workspace ', env: { NODE_ENV: 'development', 'bad-key': 'ignored', PORT: 3000 } }] }] } }] } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().templates[0].layout.windows[0], { name: 'editor', panes: [{ command: 'npm run dev', cwd: '/workspace', env: { NODE_ENV: 'development' } }], splitDirection: 'vertical', layoutPreset: 'main-vertical' })
  const list = await app.inject({ method: 'GET', url: '/api/session-templates' })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().templates[0].name, 'Dev Template')
  const saved = JSON.parse(await readFile(path.join(configDir, 'session-templates.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.templates[0].id, 'dev-template')
})
