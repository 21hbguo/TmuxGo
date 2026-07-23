export const STREAM_BINARY_VERSION = 1
export const STREAM_BINARY_TYPE_OUTPUT = 1
export const STREAM_BINARY_TYPE_RESYNC = 2

export type DecodedStreamOutput = {
  type: 'output' | 'output_resync'
  hostId: string
  sessionName: string
  data: string
}

export function decodeStreamOutputBinary(buffer: ArrayBuffer): DecodedStreamOutput | null {
  const view = new DataView(buffer)
  if (view.byteLength < 12) return null
  if (view.getUint8(0) !== 0x54 || view.getUint8(1) !== 0x47) return null
  if (view.getUint8(2) !== STREAM_BINARY_VERSION) return null
  const typeCode = view.getUint8(3)
  if (typeCode !== STREAM_BINARY_TYPE_OUTPUT && typeCode !== STREAM_BINARY_TYPE_RESYNC) return null
  const hostLen = view.getUint16(4, true)
  const sessionLen = view.getUint16(6, true)
  const dataLen = view.getUint32(8, true)
  const total = 12 + hostLen + sessionLen + dataLen
  if (view.byteLength < total) return null
  const bytes = new Uint8Array(buffer)
  const decoder = new TextDecoder()
  let offset = 12
  const hostId = decoder.decode(bytes.subarray(offset, offset + hostLen))
  offset += hostLen
  const sessionName = decoder.decode(bytes.subarray(offset, offset + sessionLen))
  offset += sessionLen
  const data = decoder.decode(bytes.subarray(offset, offset + dataLen))
  return {
    type: typeCode === STREAM_BINARY_TYPE_RESYNC ? 'output_resync' : 'output',
    hostId,
    sessionName,
    data,
  }
}
