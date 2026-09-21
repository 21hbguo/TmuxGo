import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import test from 'node:test'

test('serializes concurrent preference updates for one profile', async (t) => {
  const preferencesDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-preferences-route-'))
  const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
  process.env.TMUXGO_PREFERENCES_DIR = preferencesDir
  t.after(async () => {
    if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
    else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
    await rm(preferencesDir, { recursive: true, force: true })
  })
  const { preferencesRoutes } = await import(`./preferences.js?test=${Date.now()}-${Math.random()}`)
  const fastify = Fastify()
  await fastify.register(preferencesRoutes)
  const updatedAt = new Date(Date.now() + 1000).toISOString()
  const responses = await Promise.all([
    fastify.inject({
      method: 'PUT',
      url: '/preferences?profile=default',
      payload: { uiPreferences: { theme: 'light' }, uiPreferencesUpdatedAt: updatedAt },
    }),
    fastify.inject({
      method: 'PUT',
      url: '/preferences?profile=default',
      payload: { customShortcuts: [{ id: 'new', label: 'New', keys: 'Ctrl+N' }], customShortcutsUpdatedAt: updatedAt },
    }),
    fastify.inject({
      method: 'PUT',
      url: '/preferences?profile=default',
      payload: {
        favorites: [{ id: 'local', type: 'host', name: 'Local', target: 'local', addedAt: updatedAt }],
        favoritesUpdatedAt: updatedAt,
      },
    }),
  ])
  responses.forEach((response) => assert.equal(response.statusCode, 200))
  const stored = await fastify.inject({ method: 'GET', url: '/preferences?profile=default' })
  assert.equal(stored.statusCode, 200)
  const body = stored.json() as {
    uiPreferences: { theme?: string }
    customShortcuts: { id: string }[]
    favorites: { id: string }[]
  }
  assert.equal(body.uiPreferences.theme, 'light')
  assert.equal(body.customShortcuts[0]?.id, 'new')
  assert.equal(body.favorites[0]?.id, 'local')
  await fastify.close()
})

test('normalizes text shortcuts without losing line breaks', async (t) => {
  const preferencesDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-preferences-shortcut-'))
  const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
  process.env.TMUXGO_PREFERENCES_DIR = preferencesDir
  t.after(async () => {
    if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
    else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
    await rm(preferencesDir, { recursive: true, force: true })
  })
  const { preferencesRoutes } = await import('./preferences.js?shortcut-test=' + Date.now() + '-' + Math.random())
  const fastify = Fastify()
  await fastify.register(preferencesRoutes)
  const text = 'echo one\necho ' + 'x'.repeat(5000)
  const updatedAt = new Date(Date.now() + 1000).toISOString()
  const response = await fastify.inject({
    method: 'PUT',
    url: '/preferences?profile=default',
    payload: {
      customShortcuts: [
        { id: 'run', label: 'Run', mode: 'text', text, appendEnter: 'yes' },
        { id: 'old', label: 'Old', keys: 'Ctrl+O' },
      ],
      customShortcutsUpdatedAt: updatedAt,
    },
  })
  assert.equal(response.statusCode, 200)
  const shortcuts = response.json().customShortcuts as {
    id: string
    steps: { type: string; text?: string; keys?: string; appendEnter?: boolean }[]
  }[]
  assert.equal(shortcuts[0]?.id, 'run')
  assert.equal(shortcuts[0]?.steps?.[0]?.type, 'text')
  assert.equal(shortcuts[0]?.steps?.[0]?.text, text.slice(0, 4096))
  assert.equal(shortcuts[0]?.steps?.[0]?.text?.includes('\n'), true)
  assert.equal(shortcuts[0]?.steps?.[0]?.appendEnter, false)
  assert.equal(shortcuts[1]?.id, 'old')
  assert.equal(shortcuts[1]?.steps?.[0]?.type, 'keys')
  assert.equal(shortcuts[1]?.steps?.[0]?.keys, 'Ctrl+O')
  await fastify.close()
})

test('normalizes macro shortcut steps and drops invalid ones', async (t) => {
  const preferencesDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-preferences-shortcut-'))
  const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
  process.env.TMUXGO_PREFERENCES_DIR = preferencesDir
  t.after(async () => {
    if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
    else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
    await rm(preferencesDir, { recursive: true, force: true })
  })
  const { preferencesRoutes } = await import('./preferences.js?macro-test=' + Date.now() + '-' + Math.random())
  const fastify = Fastify()
  await fastify.register(preferencesRoutes)
  const updatedAt = new Date(Date.now() + 1000).toISOString()
  const response = await fastify.inject({
    method: 'PUT',
    url: '/preferences?profile=default',
    payload: {
      customShortcuts: [
        {
          id: 'deploy',
          label: 'Deploy',
          steps: [
            { type: 'text', text: 'cd /app', appendEnter: true },
            { type: 'wait', ms: 800 },
            { type: 'keys', keys: 'Ctrl+L' },
            { type: 'bogus', text: 'x' },
            { type: 'wait', ms: 0 },
            { type: 'text', text: '' },
            { type: 'wait', ms: 999999 },
          ],
        },
      ],
      customShortcutsUpdatedAt: updatedAt,
    },
  })
  assert.equal(response.statusCode, 200)
  const shortcuts = response.json().customShortcuts as {
    id: string
    steps: { type: string; text?: string; keys?: string; appendEnter?: boolean; ms?: number }[]
  }[]
  const steps = shortcuts[0]?.steps
  assert.equal(steps?.length, 4)
  assert.deepEqual(steps?.[0], { type: 'text', text: 'cd /app', appendEnter: true })
  assert.deepEqual(steps?.[1], { type: 'wait', ms: 800 })
  assert.deepEqual(steps?.[2], { type: 'keys', keys: 'Ctrl+L' })
  assert.deepEqual(steps?.[3], { type: 'wait', ms: 60000 })
  await fastify.close()
})

test('caps macro shortcut steps at the maximum', async (t) => {
  const preferencesDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-preferences-shortcut-'))
  const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
  process.env.TMUXGO_PREFERENCES_DIR = preferencesDir
  t.after(async () => {
    if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
    else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
    await rm(preferencesDir, { recursive: true, force: true })
  })
  const { preferencesRoutes } = await import('./preferences.js?macro-cap-test=' + Date.now() + '-' + Math.random())
  const fastify = Fastify()
  await fastify.register(preferencesRoutes)
  const updatedAt = new Date(Date.now() + 1000).toISOString()
  const steps = Array.from({ length: 55 }, (_, i) => ({ type: 'text', text: `echo ${i}`, appendEnter: true }))
  const response = await fastify.inject({
    method: 'PUT',
    url: '/preferences?profile=default',
    payload: { customShortcuts: [{ id: 'long', label: 'Long', steps }], customShortcutsUpdatedAt: updatedAt },
  })
  assert.equal(response.statusCode, 200)
  const shortcuts = response.json().customShortcuts as { id: string; steps: unknown[] }[]
  assert.equal(shortcuts[0]?.steps?.length, 50)
  await fastify.close()
})
