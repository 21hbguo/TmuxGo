import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'

// 名单只放用户可见的 session；tmuxgo-view-* 是它的分组别名，必须按组名放行
process.env.TMUX_WEB_ALLOWED_SESSIONS = 'work'
const { assertTargetAllowed, setExecTmuxForTest } = await import('./tmux-policy.js')

// key: 传给 -t 的目标（window id 或 session 名）
const targets: Record<string, { session: string; group: string }> = {
  '@7': { session: 'work-view', group: 'work' },
  '@8': { session: 'work', group: 'work' },
  '@9': { session: 'other-view', group: 'other-group' },
  '@10': { session: 'solo', group: '' },
  // 组名查询按 session 名再查一次，别名本身也要登记
  work: { session: 'work', group: 'work' },
  'work-view': { session: 'work-view', group: 'work' },
  'other-view': { session: 'other-view', group: 'other-group' },
  solo: { session: 'solo', group: '' },
}

const calls: string[][] = []
function stubTargets() {
  setExecTmuxForTest((async (hostId: string, args: string[]) => {
    calls.push(args)
    const target = args[args.indexOf('-t') + 1] || ''
    const entry = targets[target]
    const field = args[args.length - 1]
    const output = !entry ? '' : field === '#{session_group}' ? entry.group : entry.session
    return { stdout: `${output}\n`, stderr: '', host: { id: hostId } }
  }) as never)
}

test('grouped view sessions resolve to the same session set', async (t) => {
  t.after(() => setExecTmuxForTest(null))
  stubTargets()

  // window id 解析成 view 名时，按组归一到用户 session，allowlist 与归属校验都放行
  assert.equal(await assertTargetAllowed('local', '@7', 'work'), 'work-view')
  assert.equal(await assertTargetAllowed('local', '@8', 'work'), 'work')

  // 别的组不行；未分组（组名为空）也不行——组名相等才认。
  // 先过 allowlist 再过归属，两者都拒即可，不锁死具体是哪条提示
  await assert.rejects(() => assertTargetAllowed('local', '@9', 'work'), /not allowed|does not belong/)
  await assert.rejects(() => assertTargetAllowed('local', '@10', 'work'), /not allowed|does not belong/)
})

test('allowlist lets the view alias through but not a foreign group', async (t) => {
  t.after(() => setExecTmuxForTest(null))
  stubTargets()

  // 没有 expectedSessionName 时也要按组判 allowlist
  assert.equal(await assertTargetAllowed('local', '@7'), 'work-view')
  await assert.rejects(() => assertTargetAllowed('local', '@9'), /Session is not allowed/)
  await assert.rejects(() => assertTargetAllowed('local', '@10'), /Session is not allowed/)
  assert.equal(calls.length > 0, true)
})
