import type { Cell, TerminalGrid } from './grid.js'
import { emptyCell } from './grid.js'

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
  const buf = Buffer.allocUnsafe(16 + runs.length * 18)
  let o = 0
  buf.writeUInt16LE(grid.cols, o); o += 2
  buf.writeUInt16LE(grid.rows, o); o += 2
  buf.writeUInt16LE(grid.cursorX, o); o += 2
  buf.writeUInt16LE(grid.cursorY, o); o += 2
  buf.writeUInt16LE(grid.flags, o); o += 2
  buf.writeUInt32LE(grid.seq, o); o += 4
  // pad 2 to keep 16 header-ish? protocol has no pad - use exact
  // rewrite with exact protocol: cols,rows,cursorX,cursorY,flags,seq,runCount = 2*5+4+4=18
  const out = Buffer.allocUnsafe(18 + runs.length * 18)
  o = 0
  out.writeUInt16LE(grid.cols, o); o += 2
  out.writeUInt16LE(grid.rows, o); o += 2
  out.writeUInt16LE(grid.cursorX, o); o += 2
  out.writeUInt16LE(grid.cursorY, o); o += 2
  out.writeUInt16LE(grid.flags, o); o += 2
  out.writeUInt32LE(grid.seq, o); o += 4
  out.writeUInt32LE(runs.length, o); o += 4
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
  out.writeUInt16LE(0, o); o += 2 // pad for alignment
  out.writeUInt32LE(changes.length, o); o += 4
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
