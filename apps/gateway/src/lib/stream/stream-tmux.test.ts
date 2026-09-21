import '../../test-env.js'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { refreshAttachedClient, setRefreshExecForTest } from './stream-tmux.js'

type ExecCall = { hostId: string; args: string[] }
function mockExec(impl: (args: string[]) => { stdout: string }) {
  const calls: ExecCall[] = []
  setRefreshExecForTest((async (hostId: string, args: string[]) => {
    calls.push({ hostId, args })
    return { ...impl(args), stderr: '', host: null }
  }) as any)
  return calls
}
afterEach(() => setRefreshExecForTest(null))

test('refresh-client failure propagates instead of being swallowed', async () => {
  mockExec((args) => {
    if (args[0] === 'list-clients') return { stdout: '1|/dev/pts/mock\n' }
    throw new Error('refresh-client failure')
  })
  await assert.rejects(refreshAttachedClient('local', 'mock', 1), /refresh-client failure/)
})

test('empty client list rejects instead of faking success', async () => {
  mockExec(() => ({ stdout: '' }))
  await assert.rejects(refreshAttachedClient('local', 'mock', 1), /no client/)
})

test('local host without an owned client rejects instead of refreshing others', async () => {
  const calls = mockExec(() => ({ stdout: '999|/dev/pts/other\n888|/dev/pts/other2\n' }))
  await assert.rejects(refreshAttachedClient('local', 'mock', 1), /no client/)
  assert.equal(calls.filter((c) => c.args[0] === 'refresh-client').length, 0)
})

test('remote host falls back to refreshing all session clients (pid never matches)', async () => {
  const calls = mockExec((args) => {
    if (args[0] === 'list-clients') return { stdout: '7|/dev/pts/r1\n8|/dev/pts/r2\n' }
    return { stdout: '' }
  })
  await refreshAttachedClient('remote-1', 'mock', 12345)
  const refreshes = calls.filter((c) => c.args[0] === 'refresh-client').map((c) => c.args[2])
  assert.deepEqual(refreshes.sort(), ['/dev/pts/r1', '/dev/pts/r2'])
})

test('owned client match refreshes only our client', async () => {
  const calls = mockExec((args) => {
    if (args[0] === 'list-clients') return { stdout: '42|/dev/pts/mine\n7|/dev/pts/other\n' }
    return { stdout: '' }
  })
  await refreshAttachedClient('local', 'mock', 42)
  const refreshes = calls.filter((c) => c.args[0] === 'refresh-client').map((c) => c.args[2])
  assert.deepEqual(refreshes, ['/dev/pts/mine'])
})
