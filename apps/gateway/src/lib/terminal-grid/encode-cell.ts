import type { Cell, TerminalGrid } from './grid.js'
import { WIDE_CONT, emptyCell } from './grid.js'

function cellText(cell: Cell) {
  if (cell.width === 0 || cell.cp === WIDE_CONT) return ''
  if (cell.text) return cell.text
  try {
    return String.fromCodePoint(cell.cp)
  } catch {
    return ' '
  }
}

function encodeText(text: string) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > 0xffff) throw new Error('cell grapheme exceeds protocol limit')
  return bytes
}

function sameCellV2(a: Cell, b: Cell) {
  return a.width === b.width && cellText(a) === cellText(b) && a.attr === b.attr && a.fg === b.fg && a.bg === b.bg
}

export function encodeCellSnapshot(grid: TerminalGrid) {
  const runs: Array<{ runLen: number; cell: Cell }> = []
  let current = grid.cells[0] ? { ...grid.cells[0] } : emptyCell()
  let runLen = 1
  for (let i = 1; i < grid.cells.length; i++) {
    const cell = grid.cells[i]
    if (cell.cp === current.cp && cell.attr === current.attr && cell.fg === current.fg && cell.bg === current.bg) {
      runLen++
      if (runLen === 0xffff) {
        runs.push({ runLen, cell: current })
        runLen = 0
      }
    } else {
      if (runLen > 0) runs.push({ runLen, cell: current })
      current = { ...cell }
      runLen = 1
    }
  }
  if (runLen > 0) runs.push({ runLen, cell: current })
  const out = Buffer.allocUnsafe(18 + runs.length * 18)
  let o = 0
  out.writeUInt16LE(grid.cols, o); o += 2
  out.writeUInt16LE(grid.rows, o); o += 2
  out.writeUInt16LE(grid.cursorX, o); o += 2
  out.writeUInt16LE(grid.cursorY, o); o += 2
  out.writeUInt16LE(grid.flags, o); o += 2
  out.writeUInt32LE(grid.seq >>> 0, o); o += 4
  out.writeUInt32LE(runs.length >>> 0, o); o += 4
  for (const run of runs) {
    out.writeUInt16LE(run.runLen, o); o += 2
    out.writeUInt32LE(run.cell.cp >>> 0, o); o += 4
    out.writeUInt32LE(run.cell.attr >>> 0, o); o += 4
    out.writeUInt32LE(run.cell.fg >>> 0, o); o += 4
    out.writeUInt32LE(run.cell.bg >>> 0, o); o += 4
  }
  return out.subarray(0, o)
}

export function encodeCellDiff(seq: number, baseSeq: number, cursorX: number, cursorY: number, flags: number, changes: Array<{ x: number; y: number; cell: Cell }>) {
  const out = Buffer.allocUnsafe(20 + changes.length * 20)
  let o = 0
  out.writeUInt32LE(seq >>> 0, o); o += 4
  out.writeUInt32LE(baseSeq >>> 0, o); o += 4
  out.writeUInt16LE(cursorX, o); o += 2
  out.writeUInt16LE(cursorY, o); o += 2
  out.writeUInt16LE(flags, o); o += 2
  out.writeUInt16LE(0, o); o += 2
  out.writeUInt32LE(changes.length >>> 0, o); o += 4
  for (const change of changes) {
    out.writeUInt16LE(change.x, o); o += 2
    out.writeUInt16LE(change.y, o); o += 2
    out.writeUInt32LE(change.cell.cp >>> 0, o); o += 4
    out.writeUInt32LE(change.cell.attr >>> 0, o); o += 4
    out.writeUInt32LE(change.cell.fg >>> 0, o); o += 4
    out.writeUInt32LE(change.cell.bg >>> 0, o); o += 4
  }
  return out.subarray(0, o)
}

export function encodeCellSnapshotV2(grid: TerminalGrid) {
  const runs: Array<{ runLen: number; cell: Cell; text: Buffer }> = []
  let current = grid.cells[0] ? { ...grid.cells[0] } : emptyCell()
  let runLen = 1
  for (let i = 1; i < grid.cells.length; i++) {
    const cell = grid.cells[i]
    if (sameCellV2(cell, current) && runLen < 0xffff) {
      runLen++
      continue
    }
    runs.push({ runLen, cell: current, text: encodeText(cellText(current)) })
    current = { ...cell }
    runLen = 1
  }
  if (runLen > 0) runs.push({ runLen, cell: current, text: encodeText(cellText(current)) })

  const size = 20 + runs.reduce((sum, run) => sum + 18 + run.text.length, 0)
  const out = Buffer.allocUnsafe(size)
  let o = 0
  out.writeUInt16LE(grid.cols, o); o += 2
  out.writeUInt16LE(grid.rows, o); o += 2
  out.writeUInt16LE(grid.cursorX, o); o += 2
  out.writeUInt16LE(grid.cursorY, o); o += 2
  out.writeUInt16LE(grid.flags, o); o += 2
  out.writeUInt16LE(0, o); o += 2
  out.writeUInt32LE(grid.seq >>> 0, o); o += 4
  out.writeUInt32LE(runs.length >>> 0, o); o += 4
  for (const run of runs) {
    out.writeUInt16LE(run.runLen, o); o += 2
    out.writeUInt8(Math.max(0, Math.min(2, run.cell.width)), o); o += 1
    out.writeUInt8(0, o); o += 1
    out.writeUInt16LE(run.text.length, o); o += 2
    out.writeUInt32LE(run.cell.attr >>> 0, o); o += 4
    out.writeUInt32LE(run.cell.fg >>> 0, o); o += 4
    out.writeUInt32LE(run.cell.bg >>> 0, o); o += 4
    run.text.copy(out, o); o += run.text.length
  }
  return out
}

export function encodeCellDiffV2(seq: number, baseSeq: number, cursorX: number, cursorY: number, flags: number, changes: Array<{ x: number; y: number; cell: Cell }>) {
  const encoded = changes.map((change) => ({ ...change, text: encodeText(cellText(change.cell)) }))
  const size = 20 + encoded.reduce((sum, change) => sum + 20 + change.text.length, 0)
  const out = Buffer.allocUnsafe(size)
  let o = 0
  out.writeUInt32LE(seq >>> 0, o); o += 4
  out.writeUInt32LE(baseSeq >>> 0, o); o += 4
  out.writeUInt16LE(cursorX, o); o += 2
  out.writeUInt16LE(cursorY, o); o += 2
  out.writeUInt16LE(flags, o); o += 2
  out.writeUInt16LE(0, o); o += 2
  out.writeUInt32LE(encoded.length >>> 0, o); o += 4
  for (const change of encoded) {
    out.writeUInt16LE(change.x, o); o += 2
    out.writeUInt16LE(change.y, o); o += 2
    out.writeUInt8(Math.max(0, Math.min(2, change.cell.width)), o); o += 1
    out.writeUInt8(0, o); o += 1
    out.writeUInt16LE(change.text.length, o); o += 2
    out.writeUInt32LE(change.cell.attr >>> 0, o); o += 4
    out.writeUInt32LE(change.cell.fg >>> 0, o); o += 4
    out.writeUInt32LE(change.cell.bg >>> 0, o); o += 4
    change.text.copy(out, o); o += change.text.length
  }
  return out
}
