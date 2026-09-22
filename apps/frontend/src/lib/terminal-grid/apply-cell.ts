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
function fgMode(attr: number) {
  return (attr >>> 30) & 3
}
function bgMode(attr: number) {
  return (attr >>> 28) & 3
}

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

function isContinuation(cell: Cell | undefined) {
  return !!cell && (cell.width === 0 || cell.cp === WIDE_CONT)
}

function cellText(cell: Cell) {
  if (isContinuation(cell)) return ''
  return cell.text || cpToString(cell.cp) || ' '
}

export function snapshotToAnsi(snapshot: CellSnapshot) {
  let out = SYNC_BEGIN
  let lastSgr = ''
  for (let y = 0; y < snapshot.rows; y++) {
    out += `\x1b[${y + 1};1H`
    for (let x = 0; x < snapshot.cols; x++) {
      const cell = snapshot.cells[y * snapshot.cols + x]
      if (!cell) {
        out += ' '
        continue
      }
      if (isContinuation(cell)) continue
      const sgr = sgrForCell(cell)
      if (sgr !== lastSgr) {
        out += sgr
        lastSgr = sgr
      }
      out += cellText(cell)
    }
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
    if (isContinuation(change.cell)) continue
    out += `\x1b[${change.y + 1};${change.x + 1}H`
    const sgr = sgrForCell(change.cell)
    if (sgr !== lastSgr) {
      out += sgr
      lastSgr = sgr
    }
    out += cellText(change.cell)
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

type XtermLike = {
  write?: (data: string, cb?: () => void) => void
  refresh?: (start: number, end: number) => void
  buffer?: { active?: unknown }
  _core?: any
}

type WritableLine = {
  setCellFromCodepoint?: (x: number, cp: number, width: number, ch: string) => void
  loadCell?: (x: number, cell: any) => any
  setCell?: (x: number, cell: any) => void
}

type WritableBuffer = {
  lines?: { get: (y: number) => WritableLine | undefined }
  ybase?: number
  x?: number
  y?: number
  getNullCell?: () => any
}

/** 尝试取可写 buffer：公共 IBuffer 只读，走 xterm 内部 _core._bufferService */
function getWritableBuffer(terminal: XtermLike): WritableBuffer | null {
  try {
    const core = terminal?._core
    const buf = core?._bufferService?.buffer
    if (buf?.lines?.get && typeof buf.getNullCell === 'function') return buf as WritableBuffer
  } catch {}
  return null
}

const XTERM_DEFAULT_COLOR = 0x1000000
const XTERM_INDEX256 = 0x2000000
const XTERM_RGB = 0x3000000
const XTERM_BOLD = 0x8000000
const XTERM_UNDERLINE = 0x10000000
const XTERM_INVERSE = 0x4000000
const XTERM_DIM = 0x8000000

function packFg(cell: Cell, bold: boolean): number {
  const mode = fgMode(cell.attr)
  // xterm.js: 0=DEFAULT_COLOR(0x1000000), 1=256 色索引, 2=RGB 标志位
  let fg = XTERM_DEFAULT_COLOR
  if (mode === 1) fg = cell.fg & 0xff
  else if (mode === 2)
    fg = XTERM_RGB | (((cell.fg >> 16) & 0xff) << 16) | (((cell.fg >> 8) & 0xff) << 8) | (cell.fg & 0xff)
  if (bold) fg |= XTERM_BOLD
  return fg
}

function packBg(cell: Cell): number {
  const mode = bgMode(cell.attr)
  if (mode === 1) return cell.bg & 0xff
  if (mode === 2)
    return XTERM_RGB | (((cell.bg >> 16) & 0xff) << 16) | (((cell.bg >> 8) & 0xff) << 8) | (cell.bg & 0xff)
  return XTERM_DEFAULT_COLOR
}

function writeCellToBuffer(buf: WritableBuffer, x: number, y: number, cell: Cell): boolean {
  const line = buf.lines?.get((buf.ybase || 0) + y)
  if (!line) return false
  if (isContinuation(cell)) return true
  const text = cellText(cell)
  const cp = text ? text.codePointAt(0) || 0x20 : 0x20
  const width = cell.width === 2 ? 2 : 1
  try {
    if (typeof line.setCellFromCodepoint === 'function') {
      line.setCellFromCodepoint(x, cp, width, text || ' ')
    } else if (typeof line.loadCell === 'function' && typeof line.setCell === 'function') {
      const nc = buf.getNullCell!()
      const data = line.loadCell(x, nc)
      data.content = (data.content & ~0x1fffff) | (cp & 0x1fffff)
      data.fg = packFg(cell, !!(cell.attr & ATTR_BOLD))
      data.bg = packBg(cell)
      line.setCell(x, data)
    } else {
      return false
    }
    // 颜色/属性：有 fg/bg 字段时覆盖（setCellFromCodepoint 只写 content）
    if (typeof line.loadCell === 'function' && typeof line.setCell === 'function') {
      const nc = buf.getNullCell!()
      const data = line.loadCell(x, nc)
      data.fg = packFg(cell, !!(cell.attr & ATTR_BOLD))
      data.bg = packBg(cell)
      line.setCell(x, data)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 将 cell snapshot/diff 直写 xterm。
 * 1) 优先内部 buffer 可写路径（不合成全屏 ANSI、不发 \x1b[2J）
 * 2) 回退：仅脏区/逐格 write + DEC 2026 同步，仍禁止整屏擦除
 * 返回 false 表示需要走调用方的 resync/回退路径。
 */
export function applyCellToXterm(
  terminal: XtermLike,
  frame: { kind: 'snapshot'; snapshot: CellSnapshot } | { kind: 'diff'; diff: CellDiff },
): boolean {
  if (!terminal) return false
  const buf = getWritableBuffer(terminal)
  let minY = Infinity
  let maxY = -Infinity
  if (frame.kind === 'snapshot') {
    const snap = frame.snapshot
    if (!buf || !buf.lines) return applyViaWrite(terminal, frame)
    for (let y = 0; y < snap.rows; y++) {
      for (let x = 0; x < snap.cols; x++) {
        const cell = snap.cells[y * snap.cols + x]
        if (!cell) continue
        if (!writeCellToBuffer(buf, x, y, cell)) return applyViaWrite(terminal, frame)
      }
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    if (typeof buf.x === 'number') {
      buf.x = Math.max(0, Math.min(snap.cols - 1, snap.cursorX))
      buf.y = Math.max(0, Math.min(snap.rows - 1, snap.cursorY))
    }
  } else {
    const diff = frame.diff
    if (!buf || !buf.lines) return applyViaWrite(terminal, frame)
    for (const change of diff.changes) {
      if (isContinuation(change.cell)) continue
      if (!writeCellToBuffer(buf, change.x, change.y, change.cell)) return applyViaWrite(terminal, frame)
      minY = Math.min(minY, change.y)
      maxY = Math.max(maxY, change.y)
    }
    if (typeof buf.x === 'number') {
      const cols = (buf.lines?.get(0) as any)?.length ?? (terminal as any).cols ?? 80
      buf.x = Math.max(0, Math.min(Number(cols) - 1, diff.cursorX))
      buf.y = Math.max(0, diff.cursorY)
    }
  }
  if (Number.isFinite(minY) && typeof terminal.refresh === 'function') {
    terminal.refresh(Math.max(0, minY), Math.max(0, maxY))
  } else if (typeof terminal.refresh === 'function') {
    terminal.refresh(0, 0)
  }
  return true
}

/** 回退路径：DEC 2026 同步 write；snapshot 逐格覆盖，diff 只写脏区；永不 \x1b[2J */
function applyViaWrite(
  terminal: XtermLike,
  frame: { kind: 'snapshot'; snapshot: CellSnapshot } | { kind: 'diff'; diff: CellDiff },
): boolean {
  if (typeof terminal.write !== 'function') return false
  const ansi = frame.kind === 'snapshot' ? snapshotToAnsi(frame.snapshot) : diffToAnsi(frame.diff)
  if (ansi.includes('\x1b[2J') || ansi.includes('\u001b[2J')) return false
  terminal.write(ansi)
  return true
}
