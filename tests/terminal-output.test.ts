import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTerminalOutputSanitizer,
  getVisibleTerminalLines,
  hasSubstantiveTerminalContent,
  hasVisibleTerminalContent,
  stripTerminalControlSequences,
} from '../apps/gateway/src/lib/terminal-output'

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
  const statusOnly =
    '\u001b[30m\u001b[42m\r\n[zztrace_a1:sleep*                                                                                                  "guo-HP" 11:45 03-6月-26\u001b(B\u001bm\u001b[?12l\u001b[?25h\u001b[2;1H'
  assert.equal(hasVisibleTerminalContent(statusOnly), true)
  assert.equal(hasSubstantiveTerminalContent(statusOnly), false)
})

test('hasSubstantiveTerminalContent detects pane body output even with tmux status line', () => {
  const paneOutput =
    '\u001b[?25l\u001b[HZZTRACE_A_READY\u001b[K\r\n\u001b[K\r\n\u001b[30m\u001b[42m\r\n[zztrace_a1:sleep*                                                                                                  "guo-HP" 11:45 03-6月-26\u001b(B\u001bm'
  assert.equal(hasSubstantiveTerminalContent(paneOutput), true)
})

// --- light/heavy sanitize 路径 ---

test('light strips DA replies', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?1;2cnext', 'light'), 'readynext')
  assert.equal(sanitize('\u001b[0;1;2cdone', 'light'), 'done')
  assert.equal(sanitize('\u001b[cend', 'light'), 'end')
})

test('heavy strips DA replies', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?1;2cnext', 'heavy'), 'readynext')
  assert.equal(sanitize('\u001b[0;1;2cdone', 'heavy'), 'done')
})

test('light preserves normal ANSI, colors, and CJK content', () => {
  const sanitize = createTerminalOutputSanitizer()
  const chunk = '\u001b[31m错误\u001b[0m \u001b[1;32mOK\u001b[0m 中文输出 \u001b[2J\u001b[Hprompt> '
  assert.equal(sanitize(chunk, 'light'), chunk)
  assert.equal(hasVisibleTerminalContent(chunk), true)
  assert.equal(hasSubstantiveTerminalContent(chunk), true)
})

test('light carries incomplete trailing CSI across chunks', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?', 'light'), 'ready')
  assert.equal(sanitize('25lshow', 'light'), '\u001b[?25lshow')
})

test('light carries incomplete DA params across chunks', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?1;', 'light'), 'ready')
  assert.equal(sanitize('2cnext', 'light'), 'next')
})

test('light carries bare trailing ESC', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('abc\u001b', 'light'), 'abc')
  assert.equal(sanitize('[31mred', 'light'), '\u001b[31mred')
})

test('heavy still strips historical bare noise patterns', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('noise1;2;3cafter', 'heavy'), 'noiseafter')
  assert.equal(sanitize('x0;1;2cy', 'heavy'), 'xy')
  const light = createTerminalOutputSanitizer()
  assert.equal(light('noise1;2;3cafter', 'light'), 'noise1;2;3cafter')
})

test('light does not strip bare digits;c noise (only DA with CSI prefix)', () => {
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('list 1;2;3c items', 'light'), 'list 1;2;3c items')
})
