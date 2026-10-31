import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'

// allowlist 是模块加载时读 env 的常量：必须先设再动态 import
process.env.TMUX_WEB_ALLOWED_SESSIONS = 'work'
const { assertTargetAllowed, ensureGlobalRemainOnExit, setExecTmuxForTest, _resetRemainOnExitForTest } =
  await import('./tmux-policy.js')

const seen: { hostId: string; args: string[] }[] = []
function stubSession(sessionName: string) {
  setExecTmuxForTest((async (hostId: string, args: string[]) => {
    seen.push({ hostId, args })
    // 组名查询返回空串＝未分组，保持「跨 session 一律拒绝」的原口径
    const output = args[args.length - 1] === '#{session_group}' ? '' : sessionName
    return { stdout: `${output}\n`, stderr: '', host: { id: hostId } }
  }) as never)
}

test('remote target assertions resolve the session through the host channel', async (t) => {
  t.after(() => setExecTmuxForTest(null))
  seen.length = 0
  stubSession('work')

  // 远端名单内的 session 照常通过，且 display-message 是发到该 host 的
  assert.equal(await assertTargetAllowed('devbox', '%3'), 'work')
  assert.deepEqual(
    seen.map((entry) => entry.hostId),
    ['devbox'],
  )
  assert.deepEqual(seen[0].args, ['display-message', '-p', '-t', '%3', '#{session_name}'])

  // 远端名单外的 session 必须被拒——这正是远端原先整段放行漏掉的那一步
  seen.length = 0
  stubSession('prod-secrets')
  await assert.rejects(() => assertTargetAllowed('devbox', '%4'), /Session is not allowed/)
  assert.equal(seen[0].hostId, 'devbox')

  // 归属校验同样对远端生效
  stubSession('work')
  await assert.rejects(() => assertTargetAllowed('devbox', '%5', 'other'), /does not belong to session/)

  // local 行为不变：同一条断言路径，只是 hostId 为 local
  seen.length = 0
  stubSession('work')
  assert.equal(await assertTargetAllowed('local', '%1'), 'work')
  assert.equal(seen[0].hostId, 'local')

  // 解析不出 session 名时仍然是「目标不可用」，不是策略拒绝
  setExecTmuxForTest((async () => ({ stdout: '\n', stderr: '', host: { id: 'devbox' } })) as never)
  await assert.rejects(() => assertTargetAllowed('devbox', '%6'), /Unable to resolve session/)
})

test('ensureGlobalRemainOnExit pins setw -g failed once per host', async (t) => {
  t.after(() => {
    setExecTmuxForTest(null)
    _resetRemainOnExitForTest()
  })
  _resetRemainOnExitForTest()
  const calls: { hostId: string; args: string[] }[] = []
  setExecTmuxForTest((async (hostId: string, args: string[]) => {
    calls.push({ hostId, args })
    return { stdout: '', stderr: '', host: { id: hostId } }
  }) as never)

  await ensureGlobalRemainOnExit('local')
  await ensureGlobalRemainOnExit('local') // 幂等：已钉过的 host 不重复 exec
  await ensureGlobalRemainOnExit('devbox')

  assert.deepEqual(
    calls.map((c) => c.hostId),
    ['local', 'devbox'],
  )
  assert.deepEqual(calls[0].args, ['set-window-option', '-g', 'remain-on-exit', 'failed'])
})

test('ensureGlobalRemainOnExit skips hosts whose tmux rejects failed', async (t) => {
  t.after(() => {
    setExecTmuxForTest(null)
    _resetRemainOnExitForTest()
  })
  _resetRemainOnExitForTest()
  let calls = 0
  setExecTmuxForTest((async () => {
    calls += 1
    throw new Error('bad value')
  }) as never)

  await ensureGlobalRemainOnExit('old-tmux-host')
  await ensureGlobalRemainOnExit('old-tmux-host')
  assert.equal(calls, 1) // 老 tmux 探测失败后标记跳过，不随每次 attach 重放
})
