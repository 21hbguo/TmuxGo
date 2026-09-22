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
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP,
} from '../apps/gateway/src/lib/stream-binary'
import {
  TerminalGrid,
  AnsiParser,
  encodeCellSnapshot,
  encodeCellSnapshotV2,
  encodeCellDiff,
  diffCells,
} from '../apps/gateway/src/lib/terminal-grid/index'

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
  assert.ok(
    decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT || decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP,
  )
})

test('cell v2 snapshot preserves grapheme text and width', () => {
  const grid = new TerminalGrid(4, 2)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed('e\u0301').ok, true)
  grid.seq = 3
  const payload = encodeCellSnapshotV2(grid)
  assert.ok(payload.length > 20)
  const runLen = payload.readUInt16LE(20)
  const width = payload.readUInt8(22)
  const textLen = payload.readUInt16LE(24)
  const text = payload.subarray(38, 38 + textLen).toString('utf8')
  assert.equal(runLen, 1)
  assert.equal(width, 1)
  assert.equal(text, 'e\u0301')
  const frame = encodeStreamCellBinary('cell_snapshot_v2', 'local', 'dev', payload, { compress: true, threshold: 1 })
  const decoded = decodeHeader(frame)
  assert.ok(
    decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2 ||
      decoded.typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP,
  )
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

import { applyPasteDataFrame, parsePasteDataFrame } from '../apps/gateway/src/lib/stream/paste-binary.js'

function makePasteSession(overrides: Record<string, unknown> = {}) {
  const written: string[] = []
  const session = {
    attachedHostId: 'local',
    attachedSessionName: 'dev',
    attachedPassive: false,
    ptyProcess: {
      write(d: string) {
        written.push(d)
      },
    },
    // Mirrors StreamSession.input passive gate
    input(d: string) {
      if (!session.attachedPassive && session.ptyProcess) session.ptyProcess.write(d)
    },
    ...overrides,
  } as any
  return { session, written }
}

test('paste-data frame decodes and writes to matching pty', () => {
  const { session, written } = makePasteSession()
  const text = 'echo hello\nline2'
  const frame = Buffer.concat([Buffer.from('paste-data local dev\n', 'ascii'), Buffer.from(text, 'utf8')])
  const parsed = parsePasteDataFrame(frame)
  assert.deepEqual(parsed, { hostId: 'local', sessionName: 'dev', data: text })
  assert.equal(applyPasteDataFrame(session, frame), 'ok')
  assert.deepEqual(written, [text])
})

test('paste-data rejects target mismatch', () => {
  const { session, written } = makePasteSession()
  const frame = Buffer.from('paste-data local other\nxx', 'ascii')
  assert.equal(applyPasteDataFrame(session, frame), 'mismatch')
  assert.equal(written.length, 0)
})

test('paste-data refuses write when passive attach', () => {
  const { session, written } = makePasteSession({ attachedPassive: true })
  const frame = Buffer.from('paste-data local dev\nevil', 'ascii')
  assert.equal(applyPasteDataFrame(session, frame), 'ok')
  assert.equal(written.length, 0)
})

test('paste-data rejects invalid frames', () => {
  const { session, written } = makePasteSession()
  assert.equal(applyPasteDataFrame(session, Buffer.from('vnc-data x\nyy', 'ascii')), 'invalid')
  assert.equal(applyPasteDataFrame(session, Buffer.from('paste-data h', 'ascii')), 'invalid')
  assert.equal(written.length, 0)
})
