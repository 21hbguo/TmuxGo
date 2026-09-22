import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'zlib'
import {
  encodeStreamOutputBinary,
  encodeStreamOutputBinaryAsync,
  encodeStreamCellBinary,
  encodeStreamCellBinaryAsync,
  maybeGzipAsync,
  shouldMaybeGzip,
  STREAM_BINARY_TYPE_OUTPUT,
  STREAM_BINARY_TYPE_RESYNC,
  STREAM_BINARY_TYPE_OUTPUT_GZIP,
  STREAM_BINARY_TYPE_RESYNC_GZIP,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2,
  STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP,
  encodeStreamOutputBinaryCompact,
  encodeStreamOutputBinaryCompactAsync,
  encodeStreamCellBinaryCompact,
  encodeStreamCellBinaryCompactAsync,
  STREAM_BINARY_VERSION_COMPACT,
} from '../apps/gateway/src/lib/stream-binary'
import { StreamRouteDictionary, STREAM_ROUTE_MAX } from '../apps/gateway/src/lib/stream/stream-route'
import {
  maybeCompressAgentOutput,
  decodeAgentOutput,
  AGENT_COMPRESS_THRESHOLD,
} from '../apps/gateway/src/lib/agent-terminal-output'
import { applyPasteDataFrame, parsePasteDataFrame } from '../apps/gateway/src/lib/stream/paste-binary.js'
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

function decodeCompactHeader(buffer: Buffer) {
  assert.equal(buffer[0], 0x54)
  assert.equal(buffer[1], 0x47)
  assert.equal(buffer[2], STREAM_BINARY_VERSION_COMPACT)
  const typeCode = buffer[3]
  const routeIdx = buffer.readUInt16LE(4)
  const dataLen = buffer.readUInt32LE(8)
  return { typeCode, routeIdx, payload: buffer.subarray(12, 12 + dataLen) }
}

test('encodeStreamOutputBinaryCompact roundtrips with route index', () => {
  const encoded = encodeStreamOutputBinaryCompact('output', 7, 'hello-compact\n')
  const decoded = decodeCompactHeader(encoded)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_OUTPUT)
  assert.equal(decoded.routeIdx, 7)
  assert.equal(decoded.payload.toString('utf8'), 'hello-compact\n')
  assert.equal(encoded.length, 12 + Buffer.byteLength('hello-compact\n'))
})

test('compact frame smaller than v1 full header for short host/session', () => {
  const v1 = encodeStreamOutputBinary('output', 'local', 'dev', 'x')
  const v2 = encodeStreamOutputBinaryCompact('output', 1, 'x')
  assert.ok(v2.length < v1.length)
  assert.equal(v1.length - v2.length, 'local'.length + 'dev'.length)
})

test('encodeStreamOutputBinaryCompact rejects invalid route index', () => {
  assert.throws(() => encodeStreamOutputBinaryCompact('output', 0, 'x'))
  assert.throws(() => encodeStreamOutputBinaryCompact('output', 0x10000, 'x'))
})

test('stream route dictionary assigns stable indices and resolves', () => {
  const dict = new StreamRouteDictionary()
  assert.equal(dict.assign('local', 'dev'), 1)
  assert.equal(dict.assign('local', 'other'), 2)
  assert.equal(dict.assign('local', 'dev'), 1)
  assert.deepEqual(dict.resolve(1), { routeIdx: 1, hostId: 'local', sessionName: 'dev' })
  assert.equal(dict.resolve(0), null)
  assert.equal(dict.resolve(99), null)
  dict.clear()
  assert.equal(dict.size, 0)
})

test('stream route dictionary returns null when full', () => {
  const dict = new StreamRouteDictionary()
  for (let i = 1; i <= STREAM_ROUTE_MAX; i++) dict.assign('h', 's' + i)
  assert.equal(dict.assign('h', 'overflow'), null)
})

test('agent terminal-output gzip compress and decode roundtrip', () => {
  const plain = 'ansi color line with padding to exceed threshold\n'.repeat(20)
  assert.ok(Buffer.byteLength(plain) >= AGENT_COMPRESS_THRESHOLD)
  const framed = maybeCompressAgentOutput(plain, true)
  assert.equal(framed.encoding, 'gzip')
  assert.ok(framed.data.length < plain.length)
  assert.equal(decodeAgentOutput(framed.data, framed.encoding), plain)
})

test('agent terminal-output falls back to plaintext for small frames', () => {
  const framed = maybeCompressAgentOutput('tiny', true)
  assert.equal(framed.encoding, undefined)
  assert.equal(decodeAgentOutput(framed.data, undefined), 'tiny')
})

test('agent terminal-output gzip decode failure returns null (drop frame)', () => {
  assert.equal(decodeAgentOutput('not-valid-base64-gzip!!!', 'gzip'), null)
})

test('mixed v1 and compact frames decode independently', () => {
  const v1 = encodeStreamOutputBinary('output', 'local', 'dev', 'full-header')
  const v2 = encodeStreamOutputBinaryCompact('output', 3, 'compact-frame')
  assert.equal(decodeHeader(v1).hostId, 'local')
  const d2 = decodeCompactHeader(v2)
  assert.equal(d2.routeIdx, 3)
  assert.equal(d2.payload.toString('utf8'), 'compact-frame')
  assert.equal(v1[2], 1)
  assert.equal(v2[2], STREAM_BINARY_VERSION_COMPACT)
})

test('unknown route index is not resolvable (frontend drops frame)', () => {
  const dict = new StreamRouteDictionary()
  dict.assign('local', 'dev')
  const frame = encodeStreamOutputBinaryCompact('output', 9, 'orphan')
  assert.equal(dict.resolve(decodeCompactHeader(frame).routeIdx), null)
})

test('compact gzip output uses type 3 and gunzips', () => {
  const data = 'compress me '.repeat(200)
  const frame = encodeStreamOutputBinaryCompact('output', 2, data, { compress: true, threshold: 64 })
  const decoded = decodeCompactHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_OUTPUT_GZIP)
  assert.equal(gunzipSync(decoded.payload).toString('utf8'), data)
})

test('encodeStreamCellBinaryCompact roundtrips cell payload', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5])
  const frame = encodeStreamCellBinaryCompact('cell_snapshot', 4, payload, { compress: false })
  const decoded = decodeCompactHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_CELL_SNAPSHOT)
  assert.equal(decoded.routeIdx, 4)
  assert.deepEqual([...decoded.payload], [1, 2, 3, 4, 5])
})

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

test('async encode roundtrips compressed resync payload', async () => {
  const data = 'abc def ghi jkl mno pqr '.repeat(200) + '\n'
  const { frame, gzipFailed } = await encodeStreamOutputBinaryAsync('output_resync', 'local', 'dev', data, {
    compress: true,
    threshold: 4096,
  })
  assert.equal(gzipFailed, false)
  const decoded = decodeHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_RESYNC_GZIP)
  assert.equal(gunzipSync(decoded.payload).toString('utf8'), data)
  assert.ok(decoded.payload.length < Buffer.byteLength(data))
})

test('async encode keeps tiny output plaintext below threshold', async () => {
  const { frame, gzipFailed } = await encodeStreamOutputBinaryAsync('output', 'local', 'dev', 'tiny', {
    compress: true,
    threshold: 4096,
  })
  assert.equal(gzipFailed, false)
  const decoded = decodeHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_OUTPUT)
  assert.equal(decoded.payload.toString('utf8'), 'tiny')
})

test('async gzip falls back to plaintext when compression does not shrink', async () => {
  // 高熵随机负载 gzip 后不小于明文：按协议回退明文帧，且不算失败
  const raw = randomBytes(2048)
  const { payload, gzip, failed } = await maybeGzipAsync(raw, true, 0)
  assert.equal(failed, false)
  assert.equal(gzip, false)
  assert.equal(payload, raw)
})

test('async cell snapshot encode roundtrips', async () => {
  const grid = new TerminalGrid(30, 8)
  const parser = new AnsiParser(grid)
  parser.feed('hello cell payload '.repeat(40))
  grid.seq = 1
  const payload = encodeCellSnapshotV2(grid)
  const { frame, gzipFailed } = await encodeStreamCellBinaryAsync('cell_snapshot_v2', 'local', 'dev', payload, {
    compress: true,
    threshold: 256,
  })
  assert.equal(gzipFailed, false)
  const decoded = decodeHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP)
  assert.equal(gunzipSync(decoded.payload).compare(payload), 0)
})

test('shouldMaybeGzip mirrors threshold/force rules', () => {
  assert.equal(shouldMaybeGzip(100, true, 256, false), false)
  assert.equal(shouldMaybeGzip(256, true, 256, false), true)
  assert.equal(shouldMaybeGzip(10, true, 256, true), true)
  assert.equal(shouldMaybeGzip(10, false, 256, true), false)
  assert.equal(shouldMaybeGzip(0, true, 256, true), false)
})

test('async compact encode roundtrips compressed resync with route index', async () => {
  const data = 'async compact payload '.repeat(120) + '\n'
  const { frame, gzipFailed } = await encodeStreamOutputBinaryCompactAsync('output_resync', 5, data, {
    compress: true,
    threshold: 64,
  })
  assert.equal(gzipFailed, false)
  const decoded = decodeCompactHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_RESYNC_GZIP)
  assert.equal(decoded.routeIdx, 5)
  assert.equal(gunzipSync(decoded.payload).toString('utf8'), data)
})

test('async compact cell encode roundtrips', async () => {
  const payload = Buffer.from([9, 8, 7, 6])
  const { frame, gzipFailed } = await encodeStreamCellBinaryCompactAsync('cell_snapshot_v2', 3, payload, {
    compress: false,
  })
  assert.equal(gzipFailed, false)
  const decoded = decodeCompactHeader(frame)
  assert.equal(decoded.typeCode, STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2)
  assert.equal(decoded.routeIdx, 3)
  assert.deepEqual([...decoded.payload], [9, 8, 7, 6])
})
