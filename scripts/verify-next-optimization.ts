import assert from 'node:assert/strict'
import { analyzePaste, escapePaste } from '../apps/frontend/src/lib/paste-safety'
import { getNormalizedWindowMoves, getTemplateWindowTargets } from '../apps/gateway/src/lib/template-utils'

const simplePaste = analyzePaste('ls -la')
assert.equal(simplePaste.requiresConfirm, false)

const multilinePaste = analyzePaste('rm -rf /\necho done')
assert.equal(multilinePaste.requiresConfirm, true)
assert.equal(multilinePaste.hasNewline, true)

const controlPaste = analyzePaste('echo hi\u0003')
assert.equal(controlPaste.requiresConfirm, true)
assert.equal(controlPaste.hasControlChars, true)

assert.equal(escapePaste('a\tb\nc'), 'a\\tb\\nc')

const targets = getTemplateWindowTargets('demo', {
  windows: [
    { name: 'main', panes: [{}] },
    { name: 'logs', panes: [{ command: 'tail -f app.log' }, {}] },
  ],
})
assert.deepEqual(targets.map((item) => item.windowTarget), ['demo:0', 'demo:1'])
assert.equal(targets[1].panes.length, 2)

const moves = getNormalizedWindowMoves('demo', ['@3', '@1', '@2'])
assert.equal(moves.length, 6)
assert.deepEqual(moves[0], { source: '@3', target: 'demo:1000' })
assert.deepEqual(moves[5], { source: 'demo:1002', target: 'demo:2' })

console.log('verify-next-optimization: ok')
