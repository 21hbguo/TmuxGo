import test from 'node:test'
import assert from 'node:assert/strict'
import { hasVisibleTerminalContent, stripTerminalControlSequences } from '../apps/gateway/src/lib/terminal-output'

test('stripTerminalControlSequences removes ansi and control-only attach output', () => {
  assert.equal(stripTerminalControlSequences('\u001b[?25l\u001b[H\u001b[2J\u0007'), '')
})

test('hasVisibleTerminalContent ignores control-only tmux redraw output', () => {
  assert.equal(hasVisibleTerminalContent('\u001b[?25l\u001b[H\u001b[2J\u001b[?2004h'), false)
})

test('hasVisibleTerminalContent detects prompt text behind ansi styling', () => {
  assert.equal(hasVisibleTerminalContent('\u001b[38;2;12;34;56muser@host\u001b[0m$ '), true)
})
