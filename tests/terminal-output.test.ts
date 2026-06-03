import test from 'node:test'
import assert from 'node:assert/strict'
import { getVisibleTerminalLines, hasSubstantiveTerminalContent, hasVisibleTerminalContent, stripTerminalControlSequences } from '../apps/gateway/src/lib/terminal-output'

test('stripTerminalControlSequences removes ansi and control-only attach output', () => {
  assert.equal(stripTerminalControlSequences('\u001b[?25l\u001b[H\u001b[2J\u0007'), '')
})

test('stripTerminalControlSequences removes charset designation escapes', () => {
  assert.equal(stripTerminalControlSequences('\u001b(BZZTRACE_A_READY\u001b[m'), 'ZZTRACE_A_READY')
})

test('hasVisibleTerminalContent ignores control-only tmux redraw output', () => {
  assert.equal(hasVisibleTerminalContent('\u001b[?25l\u001b[H\u001b[2J\u001b[?2004h'), false)
})

test('hasVisibleTerminalContent detects prompt text behind ansi styling', () => {
  assert.equal(hasVisibleTerminalContent('\u001b[38;2;12;34;56muser@host\u001b[0m$ '), true)
})

test('getVisibleTerminalLines keeps meaningful non-empty lines only', () => {
  assert.deepEqual(getVisibleTerminalLines('\u001b[H\r\nZZTRACE_A_READY\r\n\r\n'), ['ZZTRACE_A_READY'])
})

test('hasSubstantiveTerminalContent ignores tmux status-line-only redraw output', () => {
  const statusOnly='\u001b[30m\u001b[42m\r\n[zztrace_a1:sleep*                                                                                                  \"guo-HP\" 11:45 03-6月-26\u001b(B\u001b[m\u001b[?12l\u001b[?25h\u001b[2;1H'
  assert.equal(hasVisibleTerminalContent(statusOnly), true)
  assert.equal(hasSubstantiveTerminalContent(statusOnly), false)
})

test('hasSubstantiveTerminalContent detects pane body output even with tmux status line', () => {
  const paneOutput='\u001b[?25l\u001b[HZZTRACE_A_READY\u001b[K\r\n\u001b[K\r\n\u001b[30m\u001b[42m\r\n[zztrace_a1:sleep*                                                                                                  \"guo-HP\" 11:45 03-6月-26\u001b(B\u001b[m'
  assert.equal(hasSubstantiveTerminalContent(paneOutput), true)
})
