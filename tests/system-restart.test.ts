import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { systemRoutes } from '../apps/gateway/src/routes/system.ts'
test('restart-rebuild endpoints start one fixed task and expose status', async (t) => {
  let startCalls = 0
  let state = {
    status: 'idle',
    startedAt: null as string | null,
    finishedAt: null as string | null,
    summaryLines: [] as string[],
    exitCode: null as number | null,
    errorMessage: null as string | null,
  }
  const runner = {
    getState: () => state,
    start: async () => {
      if (state.status === 'running') return state
      startCalls += 1
      state = {
        ...state,
        status: 'running',
        startedAt: '2026-06-08T00:00:00.000Z',
        summaryLines: ['Starting TmuxGo development servers...'],
      }
      return state
    },
  }
  const app = Fastify()
  await app.register(async (fastify) => {
    await systemRoutes(fastify, {
      createRestartRunner: () => runner,
    })
  }, { prefix: '/api' })
  t.after(async () => {
    await app.close()
  })
  const first = await app.inject({ method: 'POST', url: '/api/system/restart-rebuild' })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().status, 'running')
  assert.equal(startCalls, 1)
  const second = await app.inject({ method: 'POST', url: '/api/system/restart-rebuild' })
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().status, 'running')
  assert.equal(startCalls, 1)
  const current = await app.inject({ method: 'GET', url: '/api/system/restart-rebuild' })
  assert.equal(current.statusCode, 200)
  assert.deepEqual(current.json(), state)
})
