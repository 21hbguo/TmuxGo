export type Cell = { cp: number; attr: number; fg: number; bg: number }
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
    for (let r = 0; r < runLen; r++) cells.push({ cp, attr, fg, bg })
  }
  if (cells.length < total) {
    while (cells.length < total) cells.push({ cp: 0x20, attr: 0, fg: 0, bg: 0 })
  }
  return { cols, rows, cursorX, cursorY, flags, seq, cells: cells.slice(0, total) }
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
  o += 2 // pad
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
    changes.push({ x, y, cell: { cp, attr, fg, bg } })
  }
  return { seq, baseSeq, cursorX, cursorY, flags, changes }
}
