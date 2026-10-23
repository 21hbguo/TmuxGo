import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createShutdownSequence, SHUTDOWN_TIMEOUT_MS, type ShutdownDeps } from './shutdown-sequence.js'

function createDeps(overrides: Partial<ShutdownDeps> = {}) {
  const calls: string[] = []
  const deps: ShutdownDeps = {
    logWarn: (message) => calls.push(`warn:${message}`),
    logError: (error) => calls.push(`error:${(error as Error).message}`),
    stopMonitor: () => calls.push('stopMonitor'),
    unregisterAgents: (reason) => calls.push(`unregisterAgents:${reason}`),
    terminateWebSockets: () => calls.push('terminateWebSockets'),
    shutdownPlugins: async () => void calls.push('shutdownPlugins'),
    cleanupSockets: async () => void calls.push('cleanupSockets'),
    closeServer: async () => void calls.push('closeServer'),
    exit: (code) => calls.push(`exit:${code}`),
    ...overrides,
  }
  return { deps, calls }
}

test('runs the shutdown sequence in the documented order', async () => {
  const { deps, calls } = createDeps()
  await createShutdownSequence(deps)()
  assert.deepEqual(calls, [
    'stopMonitor',
    // 必须先按真实原因下线 agent，再接 terminate——顺序反过来原因会被写成 WebSocket closed
    'unregisterAgents:Gateway restarted',
    'terminateWebSockets',
    'shutdownPlugins',
    'cleanupSockets',
    'closeServer',
    'exit:0',
  ])
})

test('runs the sequence once for repeated signals', async () => {
  const { deps, calls } = createDeps()
  const shutdown = createShutdownSequence(deps)
  const first = shutdown()
  const second = shutdown()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(calls.filter((call) => call === 'stopMonitor').length, 1)
  assert.equal(calls.filter((call) => call === 'exit:0').length, 1)
})

test('exits with a failure code when a step rejects', async () => {
  const { deps, calls } = createDeps({
    cleanupSockets: async () => {
      throw new Error('socket cleanup failed')
    },
  })
  await createShutdownSequence(deps)()
  assert.deepEqual(calls, [
    'stopMonitor',
    'unregisterAgents:Gateway restarted',
    'terminateWebSockets',
    'shutdownPlugins',
    'error:socket cleanup failed',
    'exit:1',
  ])
})

test('forces a bounded exit when closeServer never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { deps, calls } = createDeps({ closeServer: () => new Promise<void>(() => {}) })
  void createShutdownSequence(deps)()
  await Promise.resolve()
  assert.equal(calls.includes('exit:1'), false)
  t.mock.timers.tick(SHUTDOWN_TIMEOUT_MS)
  assert.deepEqual(calls.slice(-2), ['warn:Graceful shutdown timed out; forcing exit', 'exit:1'])
})
