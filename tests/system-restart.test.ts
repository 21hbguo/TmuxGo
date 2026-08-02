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
    cancel: async () => {
      state = { ...state, status: 'cancelled' as const, finishedAt: '2026-06-08T00:01:00.000Z', errorMessage: 'Task cancelled' }
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
  const tasks = await app.inject({ method: 'GET', url: '/api/system/tasks' })
  assert.equal(tasks.statusCode, 200)
  assert.equal(tasks.json().tasks[0].id, 'restart-rebuild')
  assert.equal(tasks.json().tasks[0].cancellable, true)
  const cancelled = await app.inject({ method: 'POST', url: '/api/system/tasks/restart-rebuild/cancel' })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(cancelled.json().status, 'cancelled')
  assert.equal(cancelled.json().retryable, true)
  const retried = await app.inject({ method: 'POST', url: '/api/system/tasks/restart-rebuild/retry' })
  assert.equal(retried.statusCode, 200)
  assert.equal(retried.json().status, 'running')
  assert.equal(startCalls, 2)
})
