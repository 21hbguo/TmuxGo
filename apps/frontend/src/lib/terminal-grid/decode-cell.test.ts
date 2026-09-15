import { describe, expect, it } from 'vitest'
import { decodeCellSnapshotV2, type CellSnapshot, WIDE_CONT } from './decode-cell'
import { snapshotToAnsi } from './apply-cell'

function encodeSnapshotV2(cells: Array<{ text: string; width: number }>) {
  const encoder = new TextEncoder()
  const encoded = cells.map((cell) => ({ ...cell, bytes: encoder.encode(cell.text) }))
  const size = 20 + encoded.reduce((sum, cell) => sum + 18 + cell.bytes.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let o = 0
  view.setUint16(o, cells.length, true); o += 2
  view.setUint16(o, 1, true); o += 2
  view.setUint16(o, 0, true); o += 2
  view.setUint16(o, 0, true); o += 2
  view.setUint16(o, 0, true); o += 2
  view.setUint16(o, 0, true); o += 2
  view.setUint32(o, 7, true); o += 4
  view.setUint32(o, encoded.length, true); o += 4
  for (const cell of encoded) {
    view.setUint16(o, 1, true); o += 2
    view.setUint8(o, cell.width); o += 1
    view.setUint8(o, 0); o += 1
    view.setUint16(o, cell.bytes.length, true); o += 2
    view.setUint32(o, 0, true); o += 4
    view.setUint32(o, 0, true); o += 4
    view.setUint32(o, 0, true); o += 4
    out.set(cell.bytes, o); o += cell.bytes.length
  }
  return out
}

describe('cell protocol v2', () => {
  it('preserves a combining sequence as one grapheme cell', () => {
    const snapshot = decodeCellSnapshotV2(encodeSnapshotV2([{ text: 'e\u0301', width: 1 }]))
    expect(snapshot).not.toBeNull()
    expect(snapshot?.cells[0].text).toBe('e\u0301')
    expect(snapshot?.cells[0].width).toBe(1)
  })

  it('preserves wide lead and continuation widths', () => {
    const snapshot = decodeCellSnapshotV2(encodeSnapshotV2([
      { text: '你', width: 2 },
      { text: '', width: 0 },
    ]))
    expect(snapshot).not.toBeNull()
    expect(snapshot?.cells[0].text).toBe('你')
    expect(snapshot?.cells[0].width).toBe(2)
    expect(snapshot?.cells[1].cp).toBe(WIDE_CONT)
    expect(snapshot?.cells[1].width).toBe(0)
  })

  it('does not emit an extra space for a wide continuation cell', () => {
    const snapshot: CellSnapshot = {
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      flags: 0,
      seq: 1,
      cells: [
        { cp: '你'.codePointAt(0)!, text: '你', width: 2, attr: 0, fg: 0, bg: 0 },
        { cp: WIDE_CONT, text: '', width: 0, attr: 0, fg: 0, bg: 0 },
      ],
    }
    const ansi = snapshotToAnsi(snapshot)
    expect(ansi).toContain('你')
    expect(ansi).not.toContain('你 ')
  })
})
