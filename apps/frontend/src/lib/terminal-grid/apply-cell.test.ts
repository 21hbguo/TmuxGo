import { describe, expect, it } from 'vitest'
import { applyCellToXterm, diffToAnsi, snapshotToAnsi } from './apply-cell'
import { WIDE_CONT, type Cell, type CellDiff, type CellSnapshot } from './decode-cell'

function cell(text: string, width = 1): Cell {
  return { cp: text.codePointAt(0) || 0x20, text, width, attr: 0, fg: 0, bg: 0 }
}

describe('cell apply without clear-flicker', () => {
  it('normal diff ANSI never contains full erase 2J', () => {
    const diff: CellDiff = {
      seq: 2,
      baseSeq: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      changes: [{ x: 0, y: 0, cell: cell('A') }],
    }
    const ansi = diffToAnsi(diff)
    expect(ansi).not.toContain('\x1b[2J')
    expect(ansi).toContain('\x1b[?2026h')
    expect(ansi).toContain('A')
  })

  it('snapshot ANSI never contains full erase 2J', () => {
    const snap: CellSnapshot = {
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      seq: 1,
      cells: [cell('H'), cell('i')],
    }
    const ansi = snapshotToAnsi(snap)
    expect(ansi).not.toContain('\x1b[2J')
    expect(ansi).toContain('Hi')
  })

  it('skips wide continuation cells instead of emitting a space placeholder', () => {
    const snap: CellSnapshot = {
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      seq: 1,
      cells: [cell('你', 2), { cp: WIDE_CONT, text: '', width: 0, attr: 0, fg: 0, bg: 0 }],
    }
    const ansi = snapshotToAnsi(snap)
    expect(ansi).toContain('你')
    expect(ansi).not.toContain('你 ')
  })

  it('seq mismatch on applyDiffToState returns null (caller resyncs)', async () => {
    const { applyDiffToState, applySnapshotToState } = await import('./apply-cell')
    const snap: CellSnapshot = {
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      seq: 5,
      cells: [cell('x')],
    }
    const state = applySnapshotToState(snap)
    const bad: CellDiff = {
      seq: 6,
      baseSeq: 4,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      changes: [{ x: 0, y: 0, cell: cell('y') }],
    }
    expect(applyDiffToState(state, bad)).toBeNull()
    const good = { ...bad, baseSeq: 5 }
    expect(applyDiffToState(state, good)).not.toBeNull()
    expect(state.cells[0].text).toBe('y')
  })

  it('applyCellToXterm falls back to write without 2J when no writable buffer', () => {
    const writes: string[] = []
    const terminal = {
      write: (data: string) => {
        writes.push(data)
      },
      refresh: () => {},
    }
    const diff: CellDiff = {
      seq: 2,
      baseSeq: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      changes: [{ x: 0, y: 0, cell: cell('Z') }],
    }
    const ok = applyCellToXterm(terminal as any, { kind: 'diff', diff })
    expect(ok).toBe(true)
    expect(writes.join('')).toContain('Z')
    expect(writes.join('')).not.toContain('\x1b[2J')
  })

  it('applies snapshot directly into a mock writable xterm buffer', () => {
    const lines = [
      {
        setCellFromCodepoint: (x: number, _cp: number, _w: number, ch: string) => {
          rows[0][x] = ch
        },
        loadCell: () => ({ content: 0, fg: 0, bg: 0 }),
        setCell: () => {},
        length: 4,
      },
    ]
    const rows = [[' ', ' ', ' ', ' ']]
    const terminal = {
      refresh: () => {},
      _core: {
        _bufferService: {
          buffer: {
            lines: { get: (y: number) => lines[y] },
            ybase: 0,
            x: 0,
            y: 0,
            getNullCell: () => ({ content: 0, fg: 0, bg: 0 }),
          },
        },
      },
    }
    const snap: CellSnapshot = {
      cols: 2,
      rows: 1,
      cursorX: 1,
      cursorY: 0,
      flags: 0,
      seq: 1,
      cells: [cell('O'), cell('K')],
    }
    const ok = applyCellToXterm(terminal as any, { kind: 'snapshot', snapshot: snap })
    expect(ok).toBe(true)
    expect(rows[0][0]).toBe('O')
    expect(rows[0][1]).toBe('K')
    expect(terminal._core._bufferService.buffer.x).toBe(1)
  })
})
