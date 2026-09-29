import { describe, expect, it } from 'vitest'
import { countTmuxSelectionChars } from './terminal-selection-tracker'

function makeTerminal(lines: string[], cols = 80) {
  return {
    cols,
    buffer: {
      active: {
        baseY: 0,
        getLine: (y: number) =>
          lines[y] === undefined
            ? undefined
            : {
                translateToString: (trimRight: boolean, start = 0, end = cols) => {
                  const slice = lines[y].slice(start, end)
                  return trimRight ? slice.replace(/\s+$/, '') : slice
                },
              },
      },
    },
  }
}

const pane = { left: 0, top: 0, cols: 80, rows: 24 }

describe('countTmuxSelectionChars', () => {
  it('counts a single-line selection including its trailing newline', () => {
    const terminal = makeTerminal(['hello world'])
    // tmux 行选语义：选中行段后按行计数，每行右修剪并计 1 个换行
    expect(countTmuxSelectionChars(terminal, pane, { startX: 0, startY: 0, endX: 4, endY: 0 })).toBe(6)
  })
  it('counts multi-line selections one trimmed line plus newline each', () => {
    const terminal = makeTerminal(['abcdef   ', 'ghijkl'])
    // 从 (2,0) 到 (3,1)：第 0 行取 x=2..行尾("cdef")，第 1 行取 0..3("ghij")，各计换行
    expect(countTmuxSelectionChars(terminal, pane, { startX: 2, startY: 0, endX: 3, endY: 1 })).toBe(4 + 1 + 4 + 1)
  })
  it('normalizes upward selections', () => {
    const terminal = makeTerminal(['abcdef', 'ghijkl'])
    expect(countTmuxSelectionChars(terminal, pane, { startX: 3, startY: 1, endX: 2, endY: 0 })).toBe(4 + 1 + 4 + 1)
  })
  it('counts rectangle selections without trimming', () => {
    const terminal = makeTerminal(['abcdef  ', 'ghijkl  ', 'mnopqr  '])
    expect(countTmuxSelectionChars(terminal, pane, { startX: 1, startY: 0, endX: 3, endY: 2, rectangle: true })).toBe(
      3 + 1 + 3 + 1 + 3,
    )
  })
  it('translates pane-relative coordinates via pane bounds and baseY', () => {
    // buffer 行是整个 window 宽：pane left=10 → 'winC' 位于窗口行 10..13 列
    const terminal = makeTerminal(['winA', 'winB', ' '.repeat(10) + 'winC', 'winD'])
    terminal.buffer.active.baseY = 1
    const offsetPane = { left: 10, top: 1, cols: 30, rows: 10 }
    // pane top=1 + baseY=1 → 第 0 行切片对应 buffer 第 2 行
    expect(countTmuxSelectionChars(terminal, offsetPane, { startX: 0, startY: 0, endX: 3, endY: 0 })).toBe(4 + 1)
  })
  it('clamps selection rows to pane height', () => {
    const terminal = makeTerminal(['aa', 'bb', 'cc'])
    const shortPane = { left: 0, top: 0, cols: 80, rows: 3 }
    // endY 越界按 rows-1 收敛：3 行行选 = 2+1 + 2+1 + 2+1 = 9
    expect(countTmuxSelectionChars(terminal, shortPane, { startX: 0, startY: 0, endX: 79, endY: 30 })).toBe(9)
  })
  it('returns 0 for empty terminal', () => {
    expect(countTmuxSelectionChars(null, pane, { startX: 0, startY: 0, endX: 5, endY: 0 })).toBe(0)
  })
})
