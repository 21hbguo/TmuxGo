import { recordStreamMetric } from '../perf-metrics.js'
import { AnsiParser, TerminalGrid, diffCells, encodeCellDiffV2, encodeCellSnapshotV2 } from '../terminal-grid/index.js'
import { CELL_DIRTY_RATIO_SNAPSHOT } from './stream-config.js'
export type CellFeedResult =
  | { kind: 'frame'; type: 'cell_snapshot_v2' | 'cell_diff_v2'; payload: Buffer; metric: 'cellSnapshots' | 'cellDiffs' }
  | { kind: 'skip' }
  | { kind: 'fallback' }
export class StreamCellEncoder {
  grid: TerminalGrid | null = null
  parser: AnsiParser | null = null
  baseSeq = 0
  lastCursorX = -1
  lastCursorY = -1
  lastFlags = -1
  active = false
  reset(cols = 80, rows = 24, enabled = true) {
    this.grid = new TerminalGrid(Math.max(1, cols || 80), Math.max(1, rows || 24))
    this.parser = new AnsiParser(this.grid)
    this.baseSeq = 0
    this.lastCursorX = -1
    this.lastCursorY = -1
    this.lastFlags = -1
    this.active = enabled
  }
  clear() {
    this.active = false
    this.grid = null
    this.parser = null
  }
  disable() {
    if (this.active) recordStreamMetric('cellFallbackAnsi')
    this.active = false
    this.parser?.resetParserState()
  }
  feed(kind: 'output' | 'output_resync', data: string, cols: number, rows: number): CellFeedResult {
    if (!this.active || !this.grid || !this.parser) return { kind: 'fallback' }
    if (kind === 'output_resync') {
      this.grid.resize(cols || this.grid.cols, rows || this.grid.rows)
      this.grid.clear()
      this.parser.resetParserState()
      this.baseSeq = 0
    }
    const prev = this.grid.cloneCells()
    const parsed = this.parser.feed(data)
    if (!parsed.ok) {
      recordStreamMetric('cellFallbackAnsi')
      return { kind: 'fallback' }
    }
    const changes = kind === 'output_resync' ? [] : diffCells(prev, this.grid.cells, this.grid.cols, this.grid.rows)
    const total = Math.max(1, this.grid.cols * this.grid.rows)
    const dirtyRatio = kind === 'output_resync' ? 1 : changes.length / total
    const cursorChanged =
      this.grid.cursorX !== this.lastCursorX ||
      this.grid.cursorY !== this.lastCursorY ||
      this.grid.flags !== this.lastFlags
    if (kind !== 'output_resync' && this.baseSeq > 0 && changes.length === 0 && !cursorChanged) {
      return { kind: 'skip' }
    }
    this.grid.seq += 1
    recordStreamMetric('cellDirtyCells', kind === 'output_resync' ? total : changes.length)
    if (kind === 'output_resync' || dirtyRatio >= CELL_DIRTY_RATIO_SNAPSHOT || this.baseSeq === 0) {
      return {
        kind: 'frame',
        type: 'cell_snapshot_v2',
        payload: encodeCellSnapshotV2(this.grid),
        metric: 'cellSnapshots',
      }
    }
    return {
      kind: 'frame',
      type: 'cell_diff_v2',
      payload: encodeCellDiffV2(
        this.grid.seq,
        this.baseSeq,
        this.grid.cursorX,
        this.grid.cursorY,
        this.grid.flags,
        changes,
      ),
      metric: 'cellDiffs',
    }
  }
  markSent() {
    if (!this.grid) return
    this.baseSeq = this.grid.seq
    this.lastCursorX = this.grid.cursorX
    this.lastCursorY = this.grid.cursorY
    this.lastFlags = this.grid.flags
  }
}
