import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_UNDERLINE, ATTR_INVERSE } from './attrs'
import type { Cell, CellDiff, CellSnapshot } from './decode-cell'
import { WIDE_CONT } from './decode-cell'

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

export function sgrColor(mode: number, value: number, isFg: boolean) {
  const base = isFg ? 38 : 48
  if (mode === 0) return isFg ? '\x1b[39m' : '\x1b[49m'
  if (mode === 1) return `\x1b[${base};5;${value & 0xff}m`
  if (mode === 2) {
    const r = (value >> 16) & 0xff
    const g = (value >> 8) & 0xff
    const b = value & 0xff
    return `\x1b[${base};2;${r};${g};${b}m`
  }
  return ''
}

function attrBits(attr: number) {
  return attr & 0x0fffffff
}
function fgMode(attr: number) { return (attr >>> 30) & 3 }
function bgMode(attr: number) { return (attr >>> 28) & 3 }

function sgrForCell(cell: Cell) {
  let out = '\x1b[0m'
  const bits = attrBits(cell.attr)
  if (bits & ATTR_BOLD) out += '\x1b[1m'
  if (bits & ATTR_DIM) out += '\x1b[2m'
  if (bits & ATTR_ITALIC) out += '\x1b[3m'
  if (bits & ATTR_UNDERLINE) out += '\x1b[4m'
  if (bits & ATTR_INVERSE) out += '\x1b[7m'
  out += sgrColor(fgMode(cell.attr), cell.fg, true)
  out += sgrColor(bgMode(cell.attr), cell.bg, false)
  return out
}

function cpToString(cp: number) {
  if (cp === 0 || cp === WIDE_CONT) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

export function snapshotToAnsi(snapshot: CellSnapshot) {
  let out = `${SYNC_BEGIN}\x1b[H\x1b[J`
  let lastSgr = ''
  for (let y = 0; y < snapshot.rows; y++) {
    out += `\x1b[${y + 1};1H`
    for (let x = 0; x < snapshot.cols; x++) {
      const cell = snapshot.cells[y * snapshot.cols + x]
      if (!cell || cell.cp === WIDE_CONT) continue
      const sgr = sgrForCell(cell)
      if (sgr !== lastSgr) {
        out += sgr
        lastSgr = sgr
      }
      out += cpToString(cell.cp) || ' '
    }
    out += '\x1b[K'
  }
  out += `\x1b[${snapshot.cursorY + 1};${snapshot.cursorX + 1}H\x1b[0m${SYNC_END}`
  return out
}

export function diffToAnsi(diff: CellDiff) {
  if (!diff.changes.length) {
    return `${SYNC_BEGIN}\x1b[${diff.cursorY + 1};${diff.cursorX + 1}H${SYNC_END}`
  }
  let out = SYNC_BEGIN
  let lastSgr = ''
  for (const change of diff.changes) {
    if (change.cell.cp === WIDE_CONT) continue
    out += `\x1b[${change.y + 1};${change.x + 1}H`
    const sgr = sgrForCell(change.cell)
    if (sgr !== lastSgr) {
      out += sgr
      lastSgr = sgr
    }
    out += cpToString(change.cell.cp) || ' '
  }
  out += `\x1b[${diff.cursorY + 1};${diff.cursorX + 1}H\x1b[0m${SYNC_END}`
  return out
}

export function applySnapshotToState(snapshot: CellSnapshot) {
  return { seq: snapshot.seq, cols: snapshot.cols, rows: snapshot.rows, cells: snapshot.cells.slice() }
}

export function applyDiffToState(state: { seq: number; cols: number; rows: number; cells: Cell[] }, diff: CellDiff) {
  if (diff.baseSeq !== state.seq) return null
  for (const change of diff.changes) {
    const idx = change.y * state.cols + change.x
    if (idx >= 0 && idx < state.cells.length) state.cells[idx] = { ...change.cell }
  }
  state.seq = diff.seq
  return state
}
