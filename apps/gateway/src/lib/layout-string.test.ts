import '../test-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LayoutStringError,
  assertLayoutPaneCount,
  countLayoutPanes,
  layoutDimensions,
  validateLayoutString,
} from './layout-string.js'

// 这些用例只喂字符串，不碰 tmux：格式全集来自 tmux layout_dump
const nested = '709c,120x30,0,0{60x30,0,0,0,59x30,61,0,2}'
// 老版本 tmux（man tmux 的例子）叶子不带 pane 序号
const legacyNested = 'bb62,159x48,0,0{79x48,0,0,79x48,80,0}'
const single = 'b25d,80x24,0,0,0'
const deepNested = '1a2b,80x24,0,0{39x24,0,0,0,40x24,40,0{20x12,40,0,1,19x12,61,0,2}}'
// tmux 3.4 竖向分割用方括号（真机 smoke 抓到的串）
const vertical = '0ed4,120x30,0,0[120x24,0,0,3,120x5,0,25,0]'
// 横向里的一栏再上下切：两种括号混用嵌套
const mixed = '1a2b,80x24,0,0{39x24,0,0,0,40x24,40,0[20x12,40,0,1,19x12,61,0,2]}'

test('counts panes for single, nested and legacy layouts', () => {
  assert.equal(countLayoutPanes(single), 1)
  assert.equal(countLayoutPanes(nested), 2)
  assert.equal(countLayoutPanes(legacyNested), 2)
  assert.equal(countLayoutPanes(deepNested), 3)
  // 纯竖向（[]）与横竖混用都要能数
  assert.equal(countLayoutPanes(vertical), 2)
  assert.equal(countLayoutPanes(mixed), 3)
})

test('reads the window dimensions from the root cell', () => {
  assert.deepEqual(layoutDimensions(nested), { cols: 120, rows: 30 })
  assert.deepEqual(layoutDimensions(legacyNested), { cols: 159, rows: 48 })
  assert.deepEqual(layoutDimensions(deepNested), { cols: 80, rows: 24 })
  assert.deepEqual(layoutDimensions(vertical), { cols: 120, rows: 30 })
  assert.deepEqual(layoutDimensions(mixed), { cols: 80, rows: 24 })
})

test('validateLayoutString returns checksum, dimensions and pane count', () => {
  assert.deepEqual(validateLayoutString(nested), {
    checksum: '709c',
    dimensions: { cols: 120, rows: 30 },
    panes: 2,
  })
  // 前后空白不改变语义（HTTP 层常见的手滑）
  assert.equal(validateLayoutString(`  ${single}\n`).panes, 1)
})

test('rejects layouts with characters outside [0-9a-fx{},[]]', () => {
  for (const bad of [
    '709C,120x30,0,0{60x30,0,0,0,59x30,61,0,2}', // 大写十六进制
    '709c,120x30,0,0{60x30,0,0,0,59x30,61,0, 2}',
    '709c,120x30,0,0{60x30,0,0,0,59x30,61,0,2}; rm -rf /',
    "709c,120x30,0,0{60x30,0,0,0,59x30,61,0,'2'}",
  ]) {
    assert.throws(
      () => validateLayoutString(bad),
      (error: unknown) => {
        assert.ok(error instanceof LayoutStringError)
        assert.equal((error as LayoutStringError).code, 'LAYOUT_INVALID')
        return true
      },
      bad,
    )
  }
})

test('rejects empty, truncated and over-long layouts', () => {
  const cases: Record<string, unknown> = {
    empty: '',
    blank: '   ',
    'not a string': 42,
    undefined: undefined,
    // 截断：少了收尾大括号
    truncated: '709c,120x30,0,0{60x30,0,0,0,59x30,61,0,2',
    // 少了一个数字
    'missing offset': '709c,120x30,0{60x30,0,0,0,59x30,61,0,2}',
    // 校验和不是 4 位
    'bad checksum': '70c,120x30,0,0{60x30,0,0,0,59x30,61,0,2}',
    // 太短（长度下限 16）
    short: 'b25d,80x24,0,0',
    // 花括号里只有一个 cell
    'one child': '709c,120x30,0,0{120x30,0,0,0}',
    'one child square': '709c,120x30,0,0[120x30,0,0,0]',
    // 括号不配对：开 [ 却用 } 收、开 { 却用 ] 收
    'unmatched square closed by brace': '0ed4,120x30,0,0[120x24,0,0,3,120x5,0,25,0}',
    'unmatched brace closed by square': '709c,120x30,0,0{60x30,0,0,0,59x30,61,0,2]',
    // 内层括号错配：外层 {} 正确收尾，内层 [] 用了 }
    'mismatched inner': '1a2b,80x24,0,0{39x24,0,0,0,40x24,40,0[20x12,40,0,1,19x12,61,0,2}}',
    // 尾部多余数据
    'trailing data': `${single}x`,
  }
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(
      () => validateLayoutString(value),
      (error: unknown) => {
        assert.ok(error instanceof LayoutStringError, `${name} should throw LayoutStringError`)
        assert.equal((error as LayoutStringError).code, 'LAYOUT_INVALID', name)
        return true
      },
      name,
    )
  }
  // 超长（长度上限 4096）：用合法字符把串撑爆
  const overlong = `${single}${',0'.repeat(2100)}`
  assert.ok(overlong.length > 4096)
  assert.throws(() => validateLayoutString(overlong), /longer than 4096/)
})

test('assertLayoutPaneCount accepts matching counts and rejects mismatches with tmux wording', () => {
  assert.equal(assertLayoutPaneCount(nested, 2), 2)
  assert.throws(
    () => assertLayoutPaneCount(nested, 3),
    (error: unknown) => {
      assert.ok(error instanceof LayoutStringError)
      assert.equal((error as LayoutStringError).code, 'LAYOUT_PANE_MISMATCH')
      assert.equal((error as LayoutStringError).message, 'have 3 panes but need 2')
      return true
    },
  )
})
