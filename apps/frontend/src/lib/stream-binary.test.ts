import { describe, expect, it } from 'vitest'
import { decodeStreamOutputBinary, STREAM_BINARY_TYPE_OUTPUT, STREAM_BINARY_TYPE_CELL_SNAPSHOT } from './stream-binary'

function encodeFrame(typeCode: number, host: string, session: string, payload: Uint8Array) {
  const hostB = new TextEncoder().encode(host)
  const sessionB = new TextEncoder().encode(session)
  const header = new ArrayBuffer(12)
  const view = new DataView(header)
  view.setUint8(0, 0x54)
  view.setUint8(1, 0x47)
  view.setUint8(2, 1)
  view.setUint8(3, typeCode)
  view.setUint16(4, hostB.length, true)
  view.setUint16(6, sessionB.length, true)
  view.setUint32(8, payload.length, true)
  const out = new Uint8Array(12 + hostB.length + sessionB.length + payload.length)
  out.set(new Uint8Array(header), 0)
  out.set(hostB, 12)
  out.set(sessionB, 12 + hostB.length)
  out.set(payload, 12 + hostB.length + sessionB.length)
  return out.buffer
}

describe('decodeStreamOutputBinary', () => {
  it('decodes plain output', async () => {
    const payload = new TextEncoder().encode('hello')
    const decoded = await decodeStreamOutputBinary(encodeFrame(STREAM_BINARY_TYPE_OUTPUT, 'local', 'dev', payload))
    expect(decoded).toEqual({ type: 'output', hostId: 'local', sessionName: 'dev', data: 'hello' })
  })
  it('decodes cell snapshot payload bytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const decoded = await decodeStreamOutputBinary(encodeFrame(STREAM_BINARY_TYPE_CELL_SNAPSHOT, 'local', 'dev', payload))
    expect(decoded?.type).toBe('cell_snapshot')
    expect(Array.from(decoded?.cellPayload || [])).toEqual([1, 2, 3, 4])
  })
  it('returns null for unknown type', async () => {
    const payload = new TextEncoder().encode('x')
    const decoded = await decodeStreamOutputBinary(encodeFrame(99, 'local', 'dev', payload))
    expect(decoded).toBeNull()
  })
})
