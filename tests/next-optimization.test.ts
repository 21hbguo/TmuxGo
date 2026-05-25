import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzePaste, escapePaste } from '../apps/frontend/src/lib/paste-safety'
import { getNormalizedWindowMoves, getTemplateWindowTargets } from '../apps/gateway/src/lib/template-utils'

test('analyzePaste leaves simple command untouched', () => {
  const result = analyzePaste('ls -la')
  assert.equal(result.requiresConfirm, false)
  assert.equal(result.hasNewline, false)
  assert.equal(result.hasControlChars, false)
  assert.equal(result.isLong, false)
})

test('analyzePaste flags multiline and control-char input', () => {
  const multiline = analyzePaste('echo a\necho b')
  assert.equal(multiline.requiresConfirm, true)
  assert.equal(multiline.hasNewline, true)
  const control = analyzePaste('echo hi\u0003')
  assert.equal(control.requiresConfirm, true)
  assert.equal(control.hasControlChars, true)
})

test('analyzePaste flags long content', () => {
  const text = 'a'.repeat(121)
  const result = analyzePaste(text)
  assert.equal(result.requiresConfirm, true)
  assert.equal(result.isLong, true)
})

test('escapePaste makes tabs and newlines explicit', () => {
  assert.equal(escapePaste('a\tb\nc'), 'a\\tb\\nc')
  assert.equal(escapePaste('a\r\nb'), 'a\\nb')
})

test('getTemplateWindowTargets preserves window order and pane counts', () => {
  const result = getTemplateWindowTargets('demo', {
    windows: [
      { name: 'main', panes: [{}] },
      { name: 'logs', panes: [{ command: 'tail -f app.log' }, {}] },
    ],
  })
  assert.deepEqual(result.map((item) => item.windowTarget), ['demo:0', 'demo:1'])
  assert.equal(result[0].name, 'main')
  assert.equal(result[1].panes.length, 2)
})

test('getNormalizedWindowMoves generates two-phase stable reorder plan', () => {
  const result = getNormalizedWindowMoves('demo', ['@3', '@1', '@2'])
  assert.equal(result.length, 6)
  assert.deepEqual(result[0], { source: '@3', target: 'demo:1000' })
  assert.deepEqual(result[2], { source: '@2', target: 'demo:1002' })
  assert.deepEqual(result[3], { source: 'demo:1000', target: 'demo:0' })
  assert.deepEqual(result[5], { source: 'demo:1002', target: 'demo:2' })
})
