import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { encodeStreamOutputBinary } from '../apps/gateway/src/lib/stream-binary.ts'
import { AnsiParser, TerminalGrid, encodeCellSnapshot, encodeCellDiff, diffCells } from '../apps/gateway/src/lib/terminal-grid/index.ts'

const dir = join('tests/fixtures/terminal-streams')
for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith('.txt')) continue
  const text = readFileSync(join(dir, file), 'utf8')
  const plain = encodeStreamOutputBinary('output', 'local', 'dev', text, { compress: false })
  const gzip = encodeStreamOutputBinary('output_resync', 'local', 'dev', text, { compress: true, threshold: 0 })
  const grid = new TerminalGrid(80, 24)
  const parser = new AnsiParser(grid)
  const ok = parser.feed(text).ok
  grid.seq = 1
  const snap = ok ? encodeCellSnapshot(grid) : Buffer.alloc(0)
  const prev = grid.cloneCells()
  parser.feed(text)
  grid.seq = 2
  const changes = diffCells(prev, grid.cells, grid.cols, grid.rows)
  const diff = encodeCellDiff(2, 1, grid.cursorX, grid.cursorY, 0, changes)
  const ratio = plain.length ? (gzip.length / plain.length) : 1
  console.log(JSON.stringify({
    file,
    ansiBytes: plain.length,
    gzipResyncBytes: gzip.length,
    gzipRatio: Number(ratio.toFixed(3)),
    cellOk: ok,
    cellSnapshotBytes: snap.length,
    cellDiffBytes: diff.length,
    dirtyCells: changes.length,
  }))
}
