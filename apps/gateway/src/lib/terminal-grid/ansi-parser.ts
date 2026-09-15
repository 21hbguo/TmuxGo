import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_INVERSE,
  ATTR_UNDERLINE,
  BG_DEFAULT,
  BG_INDEXED,
  BG_TRUECOLOR,
  FG_DEFAULT,
  FG_INDEXED,
  FG_TRUECOLOR,
  TerminalGrid,
  WIDE_CONT,
  emptyCell,
  packColorMode,
} from './grid.js'

export type ParseResult = { ok: boolean; unsupported?: string }

type BufferCellLike = {
  getWidth: () => number
  getCode: () => number
  getChars: () => string
  getFgColor: () => number
  getBgColor: () => number
  isFgDefault: () => boolean
  isFgPalette: () => boolean
  isFgRGB: () => boolean
  isBgDefault: () => boolean
  isBgPalette: () => boolean
  isBgRGB: () => boolean
  isBold: () => number
  isDim: () => number
  isItalic: () => number
  isUnderline: () => number
  isInverse: () => number
}

type HeadlessTerminalCore = {
  writeSync: (data: string | Uint8Array, maxSubsequentCalls?: number) => void
}

function getFgMode(cell: BufferCellLike) {
  if (cell.isFgRGB()) return FG_TRUECOLOR
  if (cell.isFgPalette()) return FG_INDEXED
  return FG_DEFAULT
}

function getBgMode(cell: BufferCellLike) {
  if (cell.isBgRGB()) return BG_TRUECOLOR
  if (cell.isBgPalette()) return BG_INDEXED
  return BG_DEFAULT
}

function getAttr(cell: BufferCellLike) {
  let attr = 0
  if (cell.isBold()) attr |= ATTR_BOLD
  if (cell.isDim()) attr |= ATTR_DIM
  if (cell.isItalic()) attr |= ATTR_ITALIC
  if (cell.isUnderline()) attr |= ATTR_UNDERLINE
  if (cell.isInverse()) attr |= ATTR_INVERSE
  return packColorMode(getFgMode(cell), getBgMode(cell), attr)
}

/**
 * Cell-mode terminal state backed by xterm's VT implementation.
 *
 * The old implementation duplicated a small subset of VT/ANSI behavior in
 * this repository. That was sufficient for the original MVP, but it could
 * drift from the browser xterm state on alternate-screen, scrolling,
 * autowrap and other real-world terminal sequences. The public AnsiParser
 * shape is kept so the existing cell transport does not need a protocol or
 * routing rewrite; parsing authority now belongs to @xterm/headless.
 */
export class AnsiParser {
  grid: TerminalGrid
  private terminal: InstanceType<typeof Terminal>

  constructor(grid: TerminalGrid) {
    this.grid = grid
    this.terminal = this.createTerminal()
    this.syncGrid()
  }

  private createTerminal() {
    return new Terminal({
      cols: Math.max(2, this.grid.cols),
      rows: Math.max(1, this.grid.rows),
      scrollback: 0,
      allowProposedApi: true,
      logLevel: 'off',
    })
  }

  private getCore() {
    // @xterm/headless intentionally exposes writes asynchronously at the public
    // API. Cell transport needs the parsed buffer in the same gateway flush, so
    // we use xterm's own synchronous CoreTerminal writer. xterm's serialize
    // benchmark uses the same _core.writeSync bridge. Keep @xterm/headless on
    // the 5.x line and cover this adapter with gateway tests.
    const core = (this.terminal as unknown as { _core?: HeadlessTerminalCore })._core
    if (!core?.writeSync) throw new Error('xterm headless synchronous core writer is unavailable')
    return core
  }

  resetParserState() {
    this.terminal.reset()
    if (this.terminal.cols !== this.grid.cols || this.terminal.rows !== this.grid.rows) {
      this.terminal.resize(Math.max(2, this.grid.cols), Math.max(1, this.grid.rows))
    }
    this.syncGrid()
  }

  feed(chunk: string): ParseResult {
    if (!chunk) return { ok: true }
    try {
      if (this.terminal.cols !== this.grid.cols || this.terminal.rows !== this.grid.rows) {
        this.terminal.resize(Math.max(2, this.grid.cols), Math.max(1, this.grid.rows))
      }
      this.getCore().writeSync(chunk)
      this.syncGrid()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        unsupported: error instanceof Error ? error.message : 'xterm-headless parse failed',
      }
    }
  }

  dispose() {
    this.terminal.dispose()
  }

  private syncGrid() {
    const buffer = this.terminal.buffer.active
    const cols = this.grid.cols
    const rows = this.grid.rows
    const cells = Array.from({ length: cols * rows }, () => emptyCell())
    const reusableCell = buffer.getNullCell() as BufferCellLike

    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      if (!line) continue
      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x, reusableCell as any) as BufferCellLike | undefined
        if (!cell) continue

        const attr = getAttr(cell)
        const fg = cell.isFgDefault() ? 0 : cell.getFgColor()
        const bg = cell.isBgDefault() ? 0 : cell.getBgColor()
        if (cell.getWidth() === 0) {
          cells[y * cols + x] = { cp: WIDE_CONT, attr, fg, bg }
          continue
        }

        const chars = cell.getChars()
        const cp = cell.getCode() || chars.codePointAt(0) || 0x20
        cells[y * cols + x] = { cp, attr, fg, bg }
      }
    }

    this.grid.cells = cells
    this.grid.cursorX = Math.max(0, Math.min(cols - 1, buffer.cursorX))
    this.grid.cursorY = Math.max(0, Math.min(rows - 1, buffer.cursorY))
    this.grid.penAttr = 0
    this.grid.penFg = 0
    this.grid.penBg = 0
  }
}
