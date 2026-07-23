export const STREAM_BINARY_VERSION = 1
export const STREAM_BINARY_TYPE_OUTPUT = 1
export const STREAM_BINARY_TYPE_RESYNC = 2
export const STREAM_BINARY_TYPE_OUTPUT_GZIP = 3
export const STREAM_BINARY_TYPE_RESYNC_GZIP = 4
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT = 5
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP = 6
export const STREAM_BINARY_TYPE_CELL_DIFF = 7
export const STREAM_BINARY_TYPE_CELL_DIFF_GZIP = 8

export type DecodedStreamOutput = {
  type: 'output' | 'output_resync' | 'cell_snapshot' | 'cell_diff'
  hostId: string
  sessionName: string
  data: string
  cellPayload?: Uint8Array
}

function typeFromCode(typeCode: number): DecodedStreamOutput['type'] | null {
  if (typeCode === STREAM_BINARY_TYPE_OUTPUT || typeCode === STREAM_BINARY_TYPE_OUTPUT_GZIP) return 'output'
  if (typeCode === STREAM_BINARY_TYPE_RESYNC || typeCode === STREAM_BINARY_TYPE_RESYNC_GZIP) return 'output_resync'
  if (typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT || typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP) return 'cell_snapshot'
  if (typeCode === STREAM_BINARY_TYPE_CELL_DIFF || typeCode === STREAM_BINARY_TYPE_CELL_DIFF_GZIP) return 'cell_diff'
  return null
}

function isGzipType(typeCode: number) {
  return typeCode === STREAM_BINARY_TYPE_OUTPUT_GZIP
    || typeCode === STREAM_BINARY_TYPE_RESYNC_GZIP
    || typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP
    || typeCode === STREAM_BINARY_TYPE_CELL_DIFF_GZIP
}

export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable')
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function decodeStreamOutputBinary(buffer: ArrayBuffer): Promise<DecodedStreamOutput | null> {
  const view = new DataView(buffer)
  if (view.byteLength < 12) return null
  if (view.getUint8(0) !== 0x54 || view.getUint8(1) !== 0x47) return null
  if (view.getUint8(2) !== STREAM_BINARY_VERSION) return null
  const typeCode = view.getUint8(3)
  const kind = typeFromCode(typeCode)
  if (!kind) return null
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
  let payload = bytes.subarray(offset, offset + dataLen)
  if (isGzipType(typeCode)) {
    try {
      payload = await gunzipBytes(payload)
    } catch {
      return null
    }
  }
  if (kind === 'cell_snapshot' || kind === 'cell_diff') {
    return { type: kind, hostId, sessionName, data: '', cellPayload: payload }
  }
  return { type: kind, hostId, sessionName, data: decoder.decode(payload) }
}
