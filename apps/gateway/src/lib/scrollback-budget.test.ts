import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  MIRROR_RING_BYTES,
  MIRROR_RING_MIN_BYTES,
  MIRROR_SCROLLBACK_LINES,
  TMUX_HISTORY_LIMIT_LINES,
  estimateScrollbackMb,
} from './scrollback-budget.js'

// 回看预算的「引用一致性」断言：数字只能住在 scrollback-budget.ts，消费方必须是 import
// 而不是各写一份字面量；跨 app 的递减关系也要成立。这些断言的价值在于改数字时会立刻炸，
// 而不是等到某个端滚不到底才发现口径不一致。
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('the three tiers stay ordered: tmux >= mirror >= browser', () => {
  assert.ok(MIRROR_SCROLLBACK_LINES > 0)
  assert.ok(
    MIRROR_SCROLLBACK_LINES <= TMUX_HISTORY_LIMIT_LINES,
    '镜像比 tmux 深没有意义：镜像只是 attach 首屏，历史靠 capture-pane 回填',
  )
  // 前端常量住在另一个 app（构建目标不同，没有共享包），只能读源码核对
  const frontend = read('../../../frontend/src/lib/scrollback-budget.ts')
  const matched = frontend.match(/TERMINAL_SCROLLBACK_LINES = (\d+)/)
  assert.ok(matched, '前端预算常量必须仍然可被静态读出')
  const browserLines = Number(matched[1])
  assert.ok(
    browserLines > 0 && browserLines <= MIRROR_SCROLLBACK_LINES,
    '浏览器比镜像深没意义：超出镜像的那段 attach 后补不回来',
  )
  // 同理，前端注释里的三档数字与 gateway 侧必须一致（脱敏：只比对常量值）
  assert.ok(frontend.includes(String(TMUX_HISTORY_LIMIT_LINES)), '前端注释要写清 tmux 侧行数')
  assert.ok(frontend.includes(String(MIRROR_SCROLLBACK_LINES)), '前端注释要写清镜像行数')
})

test('the mirror ring keeps a floor and a sane size order', () => {
  assert.ok(MIRROR_RING_MIN_BYTES > 0 && MIRROR_RING_MIN_BYTES < MIRROR_RING_BYTES)
  assert.ok(MIRROR_RING_BYTES <= 4 * 1024 * 1024, '环再大就该换存储而不是堆内存')
})

test('the byte estimates quoted in the comments still hold', () => {
  // 注释里的 1.6 MB / 80 KB 就是这两个数，改常量时注释必须一起改
  assert.equal(estimateScrollbackMb(TMUX_HISTORY_LIMIT_LINES).toFixed(1), '1.6')
  assert.equal(Math.round(estimateScrollbackMb(MIRROR_SCROLLBACK_LINES) * 1000), 80)
})

test('consumers import the budget instead of re-declaring the numbers', () => {
  const policy = read('./tmux-policy.ts')
  assert.match(policy, /from '\.\/scrollback-budget\.js'/)
  assert.doesNotMatch(policy, /=\s*20000\b/, 'tmux 行数只能来自预算模块')

  const mirror = read('./stream/pane-mirror.ts')
  assert.match(mirror, /from '\.\.\/scrollback-budget\.js'/)
  assert.doesNotMatch(mirror, /256 \* 1024/, '环大小只能来自预算模块')
  assert.doesNotMatch(mirror, /\|\|\s*1000\b/, '镜像行数只能来自预算模块')
})

test('the frontend runtime consumes its budget constant', () => {
  const runtime = read('../../../frontend/src/lib/terminal-runtime.ts')
  assert.match(runtime, /from '@\/lib\/scrollback-budget'/)
  assert.doesNotMatch(runtime, /= 600\b/, '浏览器回看行数只能来自预算模块')
})
