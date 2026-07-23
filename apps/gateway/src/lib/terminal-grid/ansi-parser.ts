import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, ATTR_INVERSE, ATTR_UNDERLINE, FG_DEFAULT, FG_INDEXED, FG_TRUECOLOR, BG_DEFAULT, BG_INDEXED, BG_TRUECOLOR, TerminalGrid, packColorMode, getFgMode, getBgMode } from './grid.js'

export type ParseResult = { ok: boolean; unsupported?: string }

export class AnsiParser {
  grid: TerminalGrid
  private escaped = false
  private csi = false
  private osc = false
  private buf = ''
  private lastUnsupported: string | null = null
  constructor(grid: TerminalGrid) {
    this.grid = grid
  }
  resetParserState() {
    this.escaped = false
    this.csi = false
    this.osc = false
    this.buf = ''
  }
  feed(chunk: string): ParseResult {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      const code = chunk.charCodeAt(i)
      if (this.osc) {
        if (ch === '\x07' || (this.buf.endsWith('\x1b') && ch === '\\')) {
          this.osc = false
          this.buf = ''
          this.escaped = false
        } else this.buf += ch
        continue
      }
      if (this.csi) {
        this.buf += ch
        if (ch >= '@' && ch <= '~') {
          this.handleCsi(this.buf)
          this.csi = false
          this.buf = ''
          this.escaped = false
        }
        continue
      }
      if (this.escaped) {
        if (ch === '[') {
          this.csi = true
          this.buf = ''
          continue
        }
        if (ch === ']') {
          this.osc = true
          this.buf = ''
          continue
        }
        // simple ESC sequences ignored / unsupported
        this.escaped = false
        // ignore unsupported simple ESC forms to keep cell mode alive
        continue
      }
      if (code === 0x1b) {
        this.escaped = true
        continue
      }
      if (code < 32 && code !== 0x0a && code !== 0x0d && code !== 0x08 && code !== 0x09) continue
      if (code === 0x09) {
        const next = Math.min(this.grid.cols - 1, (Math.floor(this.grid.cursorX / 8) + 1) * 8)
        this.grid.cursorX = next
        continue
      }
      // UTF-16 surrogate pairs
      let cp = code
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < chunk.length) {
        const low = chunk.charCodeAt(i + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
          i++
        }
      }
      this.grid.putCodePoint(cp)
    }
    return { ok: true }
  }
  private handleCsi(seq: string) {
    const final = seq[seq.length - 1]
    const body = seq.slice(0, -1)
    const params = body.split(';').map((part) => {
      if (!part) return 0
      const n = Number(part)
      return Number.isFinite(n) ? n : 0
    })
    const p0 = params[0] || 0
    const p1 = params[1] || 0
    switch (final) {
      case 'A':
        this.grid.cursorY = Math.max(0, this.grid.cursorY - (p0 || 1))
        return true
      case 'B':
        this.grid.cursorY = Math.min(this.grid.rows - 1, this.grid.cursorY + (p0 || 1))
        return true
      case 'C':
        this.grid.cursorX = Math.min(this.grid.cols - 1, this.grid.cursorX + (p0 || 1))
        return true
      case 'D':
        this.grid.cursorX = Math.max(0, this.grid.cursorX - (p0 || 1))
        return true
      case 'H':
      case 'f': {
        const row = Math.max(1, p0 || 1) - 1
        const col = Math.max(1, p1 || 1) - 1
        this.grid.cursorY = Math.min(this.grid.rows - 1, row)
        this.grid.cursorX = Math.min(this.grid.cols - 1, col)
        return true
      }
      case 'J':
        this.grid.eraseInDisplay(p0 || 0)
        return true
      case 'K':
        this.grid.eraseInLine(p0 || 0)
        return true
      case 'm':
        return this.handleSgr(params.length ? params : [0])
      case 'G':
        this.grid.cursorX = Math.min(this.grid.cols - 1, Math.max(0, (p0 || 1) - 1))
        return true
      case 'd':
        this.grid.cursorY = Math.min(this.grid.rows - 1, Math.max(0, (p0 || 1) - 1))
        return true
      default:
        // ignore unknown CSI rather than fail the whole cell session
        return true
    }
  }
  private handleSgr(params: number[]) {
    let i = 0
    while (i < params.length) {
      const p = params[i] || 0
      if (p === 0) {
        this.grid.penAttr = packColorMode(FG_DEFAULT, BG_DEFAULT, 0)
        this.grid.penFg = 0
        this.grid.penBg = 0
      } else if (p === 1) this.grid.penAttr |= ATTR_BOLD
      else if (p === 2) this.grid.penAttr |= ATTR_DIM
      else if (p === 3) this.grid.penAttr |= ATTR_ITALIC
      else if (p === 4) this.grid.penAttr |= ATTR_UNDERLINE
      else if (p === 7) this.grid.penAttr |= ATTR_INVERSE
      else if (p === 22) this.grid.penAttr &= ~(ATTR_BOLD | ATTR_DIM)
      else if (p === 23) this.grid.penAttr &= ~ATTR_ITALIC
      else if (p === 24) this.grid.penAttr &= ~ATTR_UNDERLINE
      else if (p === 27) this.grid.penAttr &= ~ATTR_INVERSE
      else if (p >= 30 && p <= 37) {
        this.grid.penAttr = packColorMode(FG_INDEXED, getBgMode(this.grid.penAttr), this.grid.penAttr)
        this.grid.penFg = p - 30
      } else if (p === 39) {
        this.grid.penAttr = packColorMode(FG_DEFAULT, getBgMode(this.grid.penAttr), this.grid.penAttr)
        this.grid.penFg = 0
      } else if (p >= 40 && p <= 47) {
        this.grid.penAttr = packColorMode(getFgMode(this.grid.penAttr), BG_INDEXED, this.grid.penAttr)
        this.grid.penBg = p - 40
      } else if (p === 49) {
        this.grid.penAttr = packColorMode(getFgMode(this.grid.penAttr), BG_DEFAULT, this.grid.penAttr)
        this.grid.penBg = 0
      } else if (p >= 90 && p <= 97) {
        this.grid.penAttr = packColorMode(FG_INDEXED, getBgMode(this.grid.penAttr), this.grid.penAttr)
        this.grid.penFg = p - 90 + 8
      } else if (p >= 100 && p <= 107) {
        this.grid.penAttr = packColorMode(getFgMode(this.grid.penAttr), BG_INDEXED, this.grid.penAttr)
        this.grid.penBg = p - 100 + 8
      } else if (p === 38 || p === 48) {
        const isFg = p === 38
        const mode = params[i + 1] || 0
        if (mode === 5) {
          const idx = params[i + 2] || 0
          if (isFg) {
            this.grid.penAttr = packColorMode(FG_INDEXED, getBgMode(this.grid.penAttr), this.grid.penAttr)
            this.grid.penFg = idx & 0xff
          } else {
            this.grid.penAttr = packColorMode(getFgMode(this.grid.penAttr), BG_INDEXED, this.grid.penAttr)
            this.grid.penBg = idx & 0xff
          }
          i += 2
        } else if (mode === 2) {
          const r = params[i + 2] || 0
          const g = params[i + 3] || 0
          const b = params[i + 4] || 0
          const rgb = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
          if (isFg) {
            this.grid.penAttr = packColorMode(FG_TRUECOLOR, getBgMode(this.grid.penAttr), this.grid.penAttr)
            this.grid.penFg = rgb
          } else {
            this.grid.penAttr = packColorMode(getFgMode(this.grid.penAttr), BG_TRUECOLOR, this.grid.penAttr)
            this.grid.penBg = rgb
          }
          i += 4
        } else {
          // ignore unsupported color forms
        }
      } else if (p !== 0) {
        // ignore mild unknown sgr rather than fail hard for common reset-like values
      }
      i++
    }
    return true
  }
}
