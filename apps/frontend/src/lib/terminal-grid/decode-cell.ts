export type Cell = { cp: number; text: string; width: number; attr: number; fg: number; bg: number }
export type CellSnapshot = {
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  flags: number
  seq: number
  cells: Cell[]
}
export type CellDiff = {
  seq: number
  baseSeq: number
  cursorX: number
  cursorY: number
  flags: number
  changes: Array<{ x: number; y: number; cell: Cell }>
}

export const WIDE_CONT = 0xffffffff

function readU16(view: DataView, o: number) { return view.getUint16(o, true) }
function readU32(view: DataView, o: number) { return view.getUint32(o, true) }

function cpToText(cp: number) {
  if (cp === 0 || cp === WIDE_CONT) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ' '
  }
}

function legacyCell(cp: number, attr: number, fg: number, bg: number): Cell {
  return {
    cp,
    text: cp === WIDE_CONT ? '' : (cpToText(cp) || ' '),
    width: cp === WIDE_CONT ? 0 : 1,
    attr,
    fg,
    bg,
  }
}

function inferLegacyWideCells(cells: Cell[], cols: number, rows: number) {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x + 1 < cols; x++) {
      const cell = cells[y * cols + x]
      const next = cells[y * cols + x + 1]
      if (cell && next?.cp === WIDE_CONT) cell.width = 2
    }
  }
}

function decodeText(payload: Uint8Array, offset: number, length: number) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(offset, offset + length))
  } catch {
    return null
  }
}

function v2Cell(text: string, width: number, attr: number, fg: number, bg: number): Cell {
  if (width === 0) return { cp: WIDE_CONT, text: '', width: 0, attr, fg, bg }
  const normalized = text || ' '
  return { cp: normalized.codePointAt(0) || 0x20, text: normalized, width, attr, fg, bg }
}

export function decodeCellSnapshot(payload: Uint8Array): CellSnapshot | null {
  if (payload.length < 18) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const cols = readU16(view, o); o += 2
  const rows = readU16(view, o); o += 2
  const cursorX = readU16(view, o); o += 2
  const cursorY = readU16(view, o); o += 2
  const flags = readU16(view, o); o += 2
  const seq = readU32(view, o); o += 4
  const runCount = readU32(view, o); o += 4
  const total = cols * rows
  const cells: Cell[] = []
  for (let i = 0; i < runCount; i++) {
    if (o + 18 > payload.length) return null
    const runLen = readU16(view, o); o += 2
    const cp = readU32(view, o); o += 4
    const attr = readU32(view, o); o += 4
    const fg = readU32(view, o); o += 4
    const bg = readU32(view, o); o += 4
    if (!runLen || cells.length + runLen > total) return null
    for (let r = 0; r < runLen; r++) cells.push(legacyCell(cp, attr, fg, bg))
  }
  if (cells.length !== total) return null
  inferLegacyWideCells(cells, cols, rows)
  return { cols, rows, cursorX, cursorY, flags, seq, cells }
}

export function decodeCellDiff(payload: Uint8Array): CellDiff | null {
  if (payload.length < 20) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const seq = readU32(view, o); o += 4
  const baseSeq = readU32(view, o); o += 4
  const cursorX = readU16(view, o); o += 2
  const cursorY = readU16(view, o); o += 2
  const flags = readU16(view, o); o += 2
  o += 2
  const changeCount = readU32(view, o); o += 4
  const changes: CellDiff['changes'] = []
  for (let i = 0; i < changeCount; i++) {
    if (o + 20 > payload.length) return null
    const x = readU16(view, o); o += 2
    const y = readU16(view, o); o += 2
    const cp = readU32(view, o); o += 4
    const attr = readU32(view, o); o += 4
    const fg = readU32(view, o); o += 4
    const bg = readU32(view, o); o += 4
    changes.push({ x, y, cell: legacyCell(cp, attr, fg, bg) })
  }
  return { seq, baseSeq, cursorX, cursorY, flags, changes }
}

export function decodeCellSnapshotV2(payload: Uint8Array): CellSnapshot | null {
  if (payload.length < 20) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const cols = readU16(view, o); o += 2
  const rows = readU16(view, o); o += 2
  const cursorX = readU16(view, o); o += 2
  const cursorY = readU16(view, o); o += 2
  const flags = readU16(view, o); o += 2
  o += 2
  const seq = readU32(view, o); o += 4
  const runCount = readU32(view, o); o += 4
  const total = cols * rows
  const cells: Cell[] = []

  for (let i = 0; i < runCount; i++) {
    if (o + 18 > payload.length) return null
    const runLen = readU16(view, o); o += 2
    const width = view.getUint8(o); o += 1
    o += 1
    const textLen = readU16(view, o); o += 2
    const attr = readU32(view, o); o += 4
    const fg = readU32(view, o); o += 4
    const bg = readU32(view, o); o += 4
    if (!runLen || width > 2 || cells.length + runLen > total || o + textLen > payload.length) return null
    const text = decodeText(payload, o, textLen)
    if (text === null) return null
    o += textLen
    const cell = v2Cell(text, width, attr, fg, bg)
    for (let r = 0; r < runLen; r++) cells.push({ ...cell })
  }

  if (cells.length !== total || o !== payload.length) return null
  return { cols, rows, cursorX, cursorY, flags, seq, cells }
}

export function decodeCellDiffV2(payload: Uint8Array): CellDiff | null {
  if (payload.length < 20) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const seq = readU32(view, o); o += 4
  const baseSeq = readU32(view, o); o += 4
  const cursorX = readU16(view, o); o += 2
  const cursorY = readU16(view, o); o += 2
  const flags = readU16(view, o); o += 2
  o += 2
  const changeCount = readU32(view, o); o += 4
  const changes: CellDiff['changes'] = []

  for (let i = 0; i < changeCount; i++) {
    if (o + 20 > payload.length) return null
    const x = readU16(view, o); o += 2
    const y = readU16(view, o); o += 2
    const width = view.getUint8(o); o += 1
    o += 1
    const textLen = readU16(view, o); o += 2
    const attr = readU32(view, o); o += 4
    const fg = readU32(view, o); o += 4
    const bg = readU32(view, o); o += 4
    if (width > 2 || o + textLen > payload.length) return null
    const text = decodeText(payload, o, textLen)
    if (text === null) return null
    o += textLen
    changes.push({ x, y, cell: v2Cell(text, width, attr, fg, bg) })
  }

  if (o !== payload.length) return null
  return { seq, baseSeq, cursorX, cursorY, flags, changes }
}
