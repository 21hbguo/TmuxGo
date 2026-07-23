import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'zlib'
import {
  encodeStreamOutputBinary,
  encodeStreamCellBinary,
  STREAM_BINARY_TYPE_OUTPUT,
  STREAM_BINARY_TYPE_RESYNC,
  STREAM_BINARY_TYPE_OUTPUT_GZIP,
  STREAM_BINARY_TYPE_RESYNC_GZIP,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP,
} from '../apps/gateway/src/lib/stream-binary'
import { TerminalGrid, AnsiParser, encodeCellSnapshot, encodeCellDiff, diffCells } from '../apps/gateway/src/lib/terminal-grid/index'

function decodeHeader(buffer: Buffer) {
  assert.equal(buffer[0], 0x54)
  assert.equal(buffer[1], 0x47)
  assert.equal(buffer[2], 1)
  const typeCode = buffer[3]
  const hostLen = buffer.readUInt16LE(4)
  const sessionLen = buffer.readUInt16LE(6)
  const dataLen = buffer.readUInt32LE(8)
  let offset = 12
  const hostId = buffer.subarray(offset, offset + hostLen).toString('utf8')
  offset += hostLen
  const sessionName = buffer.subarray(offset, offset + sessionLen).toString('utf8')
  offset += sessionLen
  const payload = buffer.subarray(offset, offset + dataLen)
  return { typeCode, hostId, sessionName, payload }
}

test('encodeStreamOutputBinary roundtrips output payload', () => {
  const encoded = encodeStreamOutputBinary('output', 'local', 'dev', 'hello\n')
  const decoded = decodeHeader(encoded)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_OUTPUT)
  assert.equal(decoded.hostId, 'local')
  assert.equal(decoded.sessionName, 'dev')
  assert.equal(decoded.payload.toString('utf8'), 'hello\n')
})

test('encodeStreamOutputBinary marks resync type', () => {
  const encoded = encodeStreamOutputBinary('output_resync', 'h1', 's1', 'snap')
  const decoded = decodeHeader(encoded)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_RESYNC)
  assert.equal(decoded.payload.toString('utf8'), 'snap')
})

test('compresses large resync when enabled', () => {
  const data = 'abc def ghi jkl mno pqr '.repeat(200) + '\n'
  const encoded = encodeStreamOutputBinary('output_resync', 'local', 'dev', data, { compress: true, threshold: 4096 })
  const decoded = decodeHeader(encoded)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_RESYNC_GZIP)
  assert.equal(gunzipSync(decoded.payload).toString('utf8'), data)
  assert.ok(decoded.payload.length < Buffer.byteLength(data))
})

test('does not compress tiny output below threshold', () => {
  const encoded = encodeStreamOutputBinary('output', 'local', 'dev', 'tiny', { compress: true, threshold: 4096 })
  const decoded = decodeHeader(encoded)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_OUTPUT)
  assert.equal(decoded.payload.toString('utf8'), 'tiny')
})

test('ansi parser and cell snapshot roundtrip structure', () => {
  const grid = new TerminalGrid(40, 10)
  const parser = new AnsiParser(grid)
  const result = parser.feed('\x1b[2J\x1b[H\x1b[31mHi\x1b[0m 中')
  assert.equal(result.ok, true)
  grid.seq = 1
  const snap = encodeCellSnapshot(grid)
  assert.ok(snap.length > 18)
  const frame = encodeStreamCellBinary('cell_snapshot', 'local', 'dev', snap, { compress: true, threshold: 1 })
  const decoded = decodeHeader(frame)
  assert.ok(decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT || decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP)
})

test('cell diff encodes changes', () => {
  const grid = new TerminalGrid(20, 5)
  const parser = new AnsiParser(grid)
  parser.feed('A')
  const prev = grid.cloneCells()
  parser.feed('\rB')
  grid.seq = 2
  const changes = diffCells(prev, grid.cells, grid.cols, grid.rows)
  assert.ok(changes.length >= 1)
  const payload = encodeCellDiff(2, 1, grid.cursorX, grid.cursorY, 0, changes)
  assert.ok(payload.length >= 20)
})
