export const WIDE_CONT = 0xffffffff
export const ATTR_BOLD = 1 << 0
export const ATTR_DIM = 1 << 1
export const ATTR_ITALIC = 1 << 2
export const ATTR_UNDERLINE = 1 << 3
export const ATTR_INVERSE = 1 << 4
export const FG_DEFAULT = 0
export const FG_INDEXED = 1
export const FG_TRUECOLOR = 2
export const BG_DEFAULT = 0
export const BG_INDEXED = 1
export const BG_TRUECOLOR = 2

export type Cell = { cp: number; text: string; width: number; attr: number; fg: number; bg: number }

export function emptyCell(): Cell {
  return { cp: 0x20, text: ' ', width: 1, attr: 0, fg: 0, bg: 0 }
}

export function packColorMode(fgMode: number, bgMode: number, base = 0) {
  return (base & 0x0fffffff) | ((fgMode & 3) << 30) | ((bgMode & 3) << 28)
}

export function getFgMode(attr: number) {
  return (attr >>> 30) & 3
}

export function getBgMode(attr: number) {
  return (attr >>> 28) & 3
}

export function cellEqual(a: Cell, b: Cell) {
  return a.cp === b.cp && a.text === b.text && a.width === b.width && a.attr === b.attr && a.fg === b.fg && a.bg === b.bg
}

export function wcwidth(cp: number) {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  )) return 2
  return 1
}

export class TerminalGrid {
  cols: number
  rows: number
  cursorX = 0
  cursorY = 0
  flags = 0
  seq = 0
  cells: Cell[]
  penAttr = 0
  penFg = 0
  penBg = 0
  constructor(cols = 80, rows = 24) {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.cells = Array.from({ length: this.cols * this.rows }, () => emptyCell())
  }
  index(x: number, y: number) {
    return y * this.cols + x
  }
  get(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return emptyCell()
    return this.cells[this.index(x, y)]
  }
  set(x: number, y: number, cell: Cell) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.cells[this.index(x, y)] = { ...cell }
  }
  clear() {
    this.cells = Array.from({ length: this.cols * this.rows }, () => emptyCell())
    this.cursorX = 0
    this.cursorY = 0
  }
  resize(cols: number, rows: number) {
    const nextCols = Math.max(1, cols)
    const nextRows = Math.max(1, rows)
    const next = Array.from({ length: nextCols * nextRows }, () => emptyCell())
    const copyRows = Math.min(this.rows, nextRows)
    const copyCols = Math.min(this.cols, nextCols)
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) next[y * nextCols + x] = { ...this.get(x, y) }
    }
    this.cols = nextCols
    this.rows = nextRows
    this.cells = next
    this.cursorX = Math.min(this.cursorX, nextCols - 1)
    this.cursorY = Math.min(this.cursorY, nextRows - 1)
  }
  cloneCells() {
    return this.cells.map((cell) => ({ ...cell }))
  }
  putCodePoint(cp: number) {
    if (cp === 0x0a) {
      this.cursorX = 0
      this.cursorY = Math.min(this.rows - 1, this.cursorY + 1)
      if (this.cursorY >= this.rows - 1 && this.cursorY === this.rows - 1) {
        this.scrollUp(1)
      }
      return
    }
    if (cp === 0x0d) {
      this.cursorX = 0
      return
    }
    if (cp === 0x08) {
      this.cursorX = Math.max(0, this.cursorX - 1)
      return
    }
    const width = wcwidth(cp)
    if (width <= 0) return
    if (this.cursorX + width > this.cols) {
      this.cursorX = 0
      this.cursorY = Math.min(this.rows - 1, this.cursorY + 1)
    }
    const text = String.fromCodePoint(cp)
    const cell: Cell = { cp, text, width, attr: this.penAttr, fg: this.penFg, bg: this.penBg }
    this.set(this.cursorX, this.cursorY, cell)
    if (width === 2 && this.cursorX + 1 < this.cols) {
      this.set(this.cursorX + 1, this.cursorY, { cp: WIDE_CONT, text: '', width: 0, attr: this.penAttr, fg: this.penFg, bg: this.penBg })
    }
    this.cursorX = Math.min(this.cols - 1, this.cursorX + width)
  }
  scrollUp(n: number) {
    const lines = Math.max(0, Math.min(this.rows, n))
    if (!lines) return
    for (let y = 0; y < this.rows - lines; y++) {
      for (let x = 0; x < this.cols; x++) this.set(x, y, this.get(x, y + lines))
    }
    for (let y = this.rows - lines; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) this.set(x, y, emptyCell())
    }
  }
  eraseInDisplay(mode: number) {
    if (mode === 2 || mode === 3) {
      this.clear()
      return
    }
    if (mode === 0) {
      for (let x = this.cursorX; x < this.cols; x++) this.set(x, this.cursorY, emptyCell())
      for (let y = this.cursorY + 1; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) this.set(x, y, emptyCell())
      }
      return
    }
    if (mode === 1) {
      for (let y = 0; y < this.cursorY; y++) {
        for (let x = 0; x < this.cols; x++) this.set(x, y, emptyCell())
      }
      for (let x = 0; x <= this.cursorX; x++) this.set(x, this.cursorY, emptyCell())
    }
  }
  eraseInLine(mode: number) {
    if (mode === 2) {
      for (let x = 0; x < this.cols; x++) this.set(x, this.cursorY, emptyCell())
      return
    }
    if (mode === 0) {
      for (let x = this.cursorX; x < this.cols; x++) this.set(x, this.cursorY, emptyCell())
      return
    }
    if (mode === 1) {
      for (let x = 0; x <= this.cursorX; x++) this.set(x, this.cursorY, emptyCell())
    }
  }
}

export function diffCells(prev: Cell[], next: Cell[], cols: number, rows: number) {
  const changes: Array<{ x: number; y: number; cell: Cell }> = []
  const total = cols * rows
  for (let i = 0; i < total; i++) {
    const a = prev[i] || emptyCell()
    const b = next[i] || emptyCell()
    if (!cellEqual(a, b)) changes.push({ x: i % cols, y: Math.floor(i / cols), cell: { ...b } })
  }
  return changes
}
