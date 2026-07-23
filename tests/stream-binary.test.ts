import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeStreamOutputBinary, STREAM_BINARY_TYPE_OUTPUT, STREAM_BINARY_TYPE_RESYNC } from '../apps/gateway/src/lib/stream-binary'

function decodeLikeFrontend(buffer: Buffer) {
  if (buffer.length < 12) return null
  if (buffer[0] !== 0x54 || buffer[1] !== 0x47) return null
  if (buffer[2] !== 1) return null
  const typeCode = buffer[3]
  const hostLen = buffer.readUInt16LE(4)
  const sessionLen = buffer.readUInt16LE(6)
  const dataLen = buffer.readUInt32LE(8)
  const total = 12 + hostLen + sessionLen + dataLen
  if (buffer.length < total) return null
  let offset = 12
  const hostId = buffer.subarray(offset, offset + hostLen).toString('utf8')
  offset += hostLen
  const sessionName = buffer.subarray(offset, offset + sessionLen).toString('utf8')
  offset += sessionLen
  const data = buffer.subarray(offset, offset + dataLen).toString('utf8')
  return {
    type: typeCode === STREAM_BINARY_TYPE_RESYNC ? 'output_resync' : 'output',
    hostId,
    sessionName,
    data,
  }
}

test('encodeStreamOutputBinary roundtrips output payload', () => {
  const encoded = encodeStreamOutputBinary('output', 'local', 'dev', 'hello\n')
  const decoded = decodeLikeFrontend(encoded)
  assert.equal(decoded?.type, 'output')
  assert.equal(decoded?.hostId, 'local')
  assert.equal(decoded?.sessionName, 'dev')
  assert.equal(decoded?.data, 'hello\n')
  assert.equal(encoded[3], STREAM_BINARY_TYPE_OUTPUT)
})

test('encodeStreamOutputBinary marks resync type', () => {
  const encoded = encodeStreamOutputBinary('output_resync', 'h1', 's1', 'snap')
  const decoded = decodeLikeFrontend(encoded)
  assert.equal(decoded?.type, 'output_resync')
  assert.equal(decoded?.data, 'snap')
  assert.equal(encoded[3], STREAM_BINARY_TYPE_RESYNC)
})
