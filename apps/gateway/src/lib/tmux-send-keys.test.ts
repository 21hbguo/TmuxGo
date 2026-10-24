import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalKeyList, canonicalKeyName, listSupportedKeys, MAX_SEND_KEYS } from './tmux-keys.js'

// 纯函数用例：键名规范化是安全边界（出网关前必须翻成 tmux 官方拼写），
// 因此别名、大小写、拒绝面都要钉住

test('canonicalKeyName maps aliases to official tmux key names', () => {
  const cases: Array<[string, string]> = [
    ['Enter', 'Enter'],
    ['enter', 'Enter'],
    ['return', 'Enter'],
    ['esc', 'Escape'],
    ['Escape', 'Escape'],
    ['tab', 'Tab'],
    ['space', 'Space'],
    ['BSpace', 'BSpace'],
    ['backspace', 'BSpace'],
    ['bs', 'BSpace'],
    ['up', 'Up'],
    ['Right', 'Right'],
    ['home', 'Home'],
    ['end', 'End'],
    ['pageup', 'PPage'],
    ['pgdn', 'NPage'],
    ['delete', 'DC'],
    ['insert', 'IC'],
    ['f1', 'F1'],
    ['f12', 'F12'],
    // 组合键：修饰键归一成大写、字符归一成小写
    ['C-a', 'C-a'],
    ['c-A', 'C-a'],
    ['M-x', 'M-x'],
    ['s-1', 'S-1'],
  ]
  for (const [input, expected] of cases) assert.equal(canonicalKeyName(input), expected, `canonicalKeyName(${input})`)
  // 前后空白容忍，内部空白不容忍
  assert.equal(canonicalKeyName('  esc '), 'Escape')
  assert.equal(canonicalKeyName('c - a'), null)
})

test('canonicalKeyName rejects everything outside the closed allowlist', () => {
  for (const input of [
    '',
    '   ',
    'a', // 裸字符不是动作，文本走 panes/run
    'A',
    '1',
    'ctrl+nope',
    'ctrl+c', // herdr 拼法不认，必须 C-c
    'C-Ab', // 组合键只放行单字符
    'C-M-x', // 多修饰键刻意不支持
    'C-Left', // 修饰键 + 具名键刻意不支持
    'Enter;rm -rf /', // 任何拼接企图
    '\u001b',
  ])
    assert.equal(canonicalKeyName(input), null, `expected reject: ${JSON.stringify(input)}`)
  assert.equal(canonicalKeyName(42 as unknown as string), null)
})

test('canonicalKeyList is all-or-nothing and reports every invalid entry', () => {
  assert.deepEqual(canonicalKeyList(['esc', 'C-c']), { ok: true, keys: ['Escape', 'C-c'] })
  // 任一非法 → 整体失败，且一次列出全部非法项（不只第一个）
  assert.deepEqual(canonicalKeyList(['esc', 'bogus', 'Enter', 'nope']), {
    ok: false,
    invalid: ['bogus', 'nope'],
  })
  assert.deepEqual(canonicalKeyList([]), { ok: false, invalid: [] })
  assert.deepEqual(canonicalKeyList('esc' as unknown as string[]), { ok: false, invalid: [] })
  // 超长非法项截断回报，避免把巨型输入回显给调用方
  const long = 'x'.repeat(200)
  assert.deepEqual(canonicalKeyList([long]), { ok: false, invalid: [long.slice(0, 64)] })
})

test('supported key table is enumerable and matches the documented surface', () => {
  const { named, modified } = listSupportedKeys()
  assert.equal(named.length, 27) // 15 具名键 + F1-F12
  assert.ok(named.includes('PPage') && named.includes('NPage') && named.includes('DC') && named.includes('IC'))
  assert.deepEqual(modified, ['C-[a-z0-9]', 'M-[a-z0-9]', 'S-[a-z0-9]'])
  assert.equal(MAX_SEND_KEYS, 16)
})
