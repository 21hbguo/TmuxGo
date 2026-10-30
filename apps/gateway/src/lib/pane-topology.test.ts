import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBreakPaneArgs,
  buildJoinPaneArgs,
  buildSwapPaneArgs,
  classifyPaneTopologyError,
  PaneTopologyError,
  parsePaneRef,
  parseWindowRef,
} from './pane-topology.js'

function assertTopologyError(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof PaneTopologyError && error.code === code)
}

test('join-pane 默认横向，target 用窗口 id', () => {
  assert.deepEqual(buildJoinPaneArgs({ paneId: 'local:%3', targetWindowId: 'local:@7' }), [
    'join-pane',
    '-d',
    '-h',
    '-s',
    '%3',
    '-t',
    '@7',
  ])
})

// 纵向 + 百分比尺寸：-v 与 -l n% 同时出现，顺序固定便于断言
test('join-pane 纵向且指定 sizePercent', () => {
  assert.deepEqual(
    buildJoinPaneArgs({ paneId: 'local:%3', targetPaneId: 'local:%9', direction: 'vertical', sizePercent: 40 }),
    ['join-pane', '-d', '-v', '-l', '40%', '-s', '%3', '-t', '%9'],
  )
})

test('join-pane 拒绝缺 target、双 target、跨 host、同 pane', () => {
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%3' }), 'MISSING_TARGET')
  assertTopologyError(
    () => buildJoinPaneArgs({ paneId: 'local:%3', targetWindowId: 'local:@7', targetPaneId: 'local:%9' }),
    'MULTIPLE_TARGETS',
  )
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%3', targetPaneId: 'remote:%4' }), 'CROSS_HOST')
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%3', targetWindowId: 'remote:@4' }), 'CROSS_HOST')
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%3', targetPaneId: 'local:%3' }), 'SAME_PANE')
})

// 10/90 是闭区间端点（要能通过），其余一律 400
test('join-pane sizePercent 只接受 10-90 的整数', () => {
  for (const sizePercent of [9, 91, 33.5, 0, -10]) {
    assertTopologyError(
      () => buildJoinPaneArgs({ paneId: 'local:%1', targetWindowId: 'local:@2', sizePercent }),
      'INVALID_SIZE',
    )
  }
  assert.ok(buildJoinPaneArgs({ paneId: 'local:%1', targetWindowId: 'local:@2', sizePercent: 10 }).includes('10%'))
  assert.ok(buildJoinPaneArgs({ paneId: 'local:%1', targetWindowId: 'local:@2', sizePercent: 90 }).includes('90%'))
})

test('join-pane 拒绝非法方向与非法引用', () => {
  assertTopologyError(
    () => buildJoinPaneArgs({ paneId: 'local:%1', targetWindowId: 'local:@2', direction: 'diagonal' as never }),
    'INVALID_DIRECTION',
  )
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:bad', targetWindowId: 'local:@2' }), 'INVALID_PANE_ID')
  // window 引用误写成 pane 引用时不能被当成窗口
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%1', targetWindowId: 'local:%2' }), 'INVALID_WINDOW_ID')
  assertTopologyError(() => buildJoinPaneArgs({ paneId: 'local:%1', targetPaneId: 'local:@2' }), 'INVALID_PANE_ID')
})

test('break-pane 带 name 与不带 name', () => {
  assert.deepEqual(buildBreakPaneArgs({ paneId: 'local:%4' }), ['break-pane', '-d', '-s', '%4'])
  assert.deepEqual(buildBreakPaneArgs({ paneId: 'local:%4', name: 'topo-break' }), [
    'break-pane',
    '-d',
    '-s',
    '%4',
    '-n',
    'topo-break',
  ])
})

test('break-pane 拒绝空名 / 超长名 / 控制字符', () => {
  for (const name of ['', 'x'.repeat(65), 'bad\nname', 'bad\tname', 'bad\u007fname'])
    assertTopologyError(() => buildBreakPaneArgs({ paneId: 'local:%4', name }), 'INVALID_NAME')
})

test('swap-pane argv 与同 pane / 跨 host 校验', () => {
  assert.deepEqual(buildSwapPaneArgs({ paneId: 'local:%5', targetPaneId: 'local:%8' }), [
    'swap-pane',
    '-s',
    '%5',
    '-t',
    '%8',
  ])
  assertTopologyError(() => buildSwapPaneArgs({ paneId: 'local:%5', targetPaneId: 'local:%5' }), 'SAME_PANE')
  assertTopologyError(() => buildSwapPaneArgs({ paneId: 'local:%5', targetPaneId: 'remote:%8' }), 'CROSS_HOST')
  assertTopologyError(() => buildSwapPaneArgs({ paneId: 'local:%5', targetPaneId: '' }), 'MISSING_TARGET')
})

test('parsePaneRef / parseWindowRef 只认 <host>:%n 与 <host>:@n', () => {
  assert.deepEqual(parsePaneRef('local:%12'), { hostId: 'local', tmuxPaneId: '%12' })
  assert.deepEqual(parseWindowRef('box:@3'), { hostId: 'box', tmuxWindowId: '@3' })
  for (const paneId of ['', 'local', 'local:', ': %1', 'local:1', '%1'])
    assertTopologyError(() => parsePaneRef(paneId), 'INVALID_PANE_ID')
  for (const windowId of ['', 'local', 'local:', 'local:3', 'local:%3'])
    assertTopologyError(() => parseWindowRef(windowId), 'INVALID_WINDOW_ID')
})

test('失败归类：结构化 403 / allowlist 403 / 缺失 404 / 通道异常 502', () => {
  assert.deepEqual(
    classifyPaneTopologyError(new PaneTopologyError('SESSION_NOT_ALLOWED', 'Session is not allowed', 403)),
    {
      statusCode: 403,
      message: 'Session is not allowed',
    },
  )
  assert.equal(classifyPaneTopologyError(new Error('Session is not allowed')).statusCode, 403)
  assert.equal(classifyPaneTopologyError(new Error('Invalid pane id')).statusCode, 400)
  assert.equal(classifyPaneTopologyError(new Error("can't find pane %9")).statusCode, 404)
  assert.equal(classifyPaneTopologyError(new Error('Unable to resolve session')).statusCode, 404)
  assert.equal(classifyPaneTopologyError(new Error('ssh: connect to host failed')).statusCode, 502)
  assert.deepEqual(classifyPaneTopologyError('weird'), { statusCode: 502, message: 'Request failed' })
})
