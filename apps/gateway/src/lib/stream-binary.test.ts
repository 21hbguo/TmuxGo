import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STREAM_BINARY_TYPE_OUTPUT,
  STREAM_BINARY_VERSION_COMPACT,
  STREAM_BINARY_VERSION_COMPACT_SEQ,
  encodeStreamOutputBinaryCompact,
} from './stream-binary.js'

test('compact v3 header carries the mirror sequence', () => {
  const frame = encodeStreamOutputBinaryCompact('output', 3, 'hello', { mirrorSeq: 12345 })
  assert.equal(frame.length, 16 + 5)
  assert.equal(frame[2], STREAM_BINARY_VERSION_COMPACT_SEQ)
  assert.equal(frame[3], STREAM_BINARY_TYPE_OUTPUT)
  assert.equal(frame.readUInt16LE(4), 3)
  // payloadLen 位置与 v2 保持一致，payload 后移到 16
  assert.equal(frame.readUInt32LE(8), 5)
  assert.equal(frame.readUInt32LE(12), 12345)
  assert.equal(frame.subarray(16).toString('utf8'), 'hello')
})

test('compact v2 header is kept when the client did not opt in', () => {
  const frame = encodeStreamOutputBinaryCompact('output', 3, 'hello')
  assert.equal(frame.length, 12 + 5)
  assert.equal(frame[2], STREAM_BINARY_VERSION_COMPACT)
  assert.equal(frame.readUInt32LE(8), 5)
  assert.equal(frame.subarray(12).toString('utf8'), 'hello')
})

test('mirror sequence survives payload compression', () => {
  // 头不参与压缩：gzip 只作用于 payload，seq 仍留在 offset 12
  const payload = 'x'.repeat(4096)
  const frame = encodeStreamOutputBinaryCompact('output', 1, payload, { compress: true, threshold: 128, mirrorSeq: 7 })
  assert.equal(frame[2], STREAM_BINARY_VERSION_COMPACT_SEQ)
  assert.equal(frame.readUInt32LE(12), 7)
  assert.equal(frame.readUInt32LE(8), frame.length - 16)
  // 压缩后的 payload 不该是明文
  assert.notEqual(frame.subarray(16, 20).toString('utf8'), 'xxxx')
})

test('a zero sequence is still a real sequence', () => {
  // 0 是合法起点（镜像还没喂过输出）：不能被当成「未提供」退回 v2 头
  const frame = encodeStreamOutputBinaryCompact('output', 1, 'a', { mirrorSeq: 0 })
  assert.equal(frame[2], STREAM_BINARY_VERSION_COMPACT_SEQ)
  assert.equal(frame.length, 17)
})
