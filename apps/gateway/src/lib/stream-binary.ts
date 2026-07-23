import { gzipSync, gunzipSync } from 'zlib'

export const STREAM_BINARY_VERSION = 1
export const STREAM_BINARY_TYPE_OUTPUT = 1
export const STREAM_BINARY_TYPE_RESYNC = 2
export const STREAM_BINARY_TYPE_OUTPUT_GZIP = 3
export const STREAM_BINARY_TYPE_RESYNC_GZIP = 4
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT = 5
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP = 6
export const STREAM_BINARY_TYPE_CELL_DIFF = 7
export const STREAM_BINARY_TYPE_CELL_DIFF_GZIP = 8

export type StreamBinaryAnsiType = 'output' | 'output_resync'
export type StreamBinaryCellType = 'cell_snapshot' | 'cell_diff'

function typeCodeOf(type: StreamBinaryAnsiType | StreamBinaryCellType, gzip: boolean) {
  if (type === 'output') return gzip ? STREAM_BINARY_TYPE_OUTPUT_GZIP : STREAM_BINARY_TYPE_OUTPUT
  if (type === 'output_resync') return gzip ? STREAM_BINARY_TYPE_RESYNC_GZIP : STREAM_BINARY_TYPE_RESYNC
  if (type === 'cell_snapshot') return gzip ? STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP : STREAM_BINARY_TYPE_CELL_SNAPSHOT
  return gzip ? STREAM_BINARY_TYPE_CELL_DIFF_GZIP : STREAM_BINARY_TYPE_CELL_DIFF
}

export function gzipPayload(data: Buffer) {
  return gzipSync(data)
}

export function gunzipPayload(data: Buffer) {
  return gunzipSync(data)
}

export function maybeGzip(data: Buffer, enabled: boolean, threshold: number) {
  if (!enabled) return { payload: data, gzip: false }
  if (threshold > 0 && data.length < threshold) return { payload: data, gzip: false }
  if (!data.length) return { payload: data, gzip: false }
  const compressed = gzipSync(data)
  if (compressed.length >= data.length) return { payload: data, gzip: false }
  return { payload: compressed, gzip: true }
}

export function encodeStreamBinaryFrame(type: StreamBinaryAnsiType | StreamBinaryCellType, hostId: string, sessionName: string, payload: Buffer, gzip = false) {
  const host = Buffer.from(hostId || '', 'utf8')
  const session = Buffer.from(sessionName || '', 'utf8')
  if (host.length > 0xffff || session.length > 0xffff) throw new Error('stream binary header too large')
  const header = Buffer.allocUnsafe(12)
  header.writeUInt8(0x54, 0)
  header.writeUInt8(0x47, 1)
  header.writeUInt8(STREAM_BINARY_VERSION, 2)
  header.writeUInt8(typeCodeOf(type, gzip), 3)
  header.writeUInt16LE(host.length, 4)
  header.writeUInt16LE(session.length, 6)
  header.writeUInt32LE(payload.length, 8)
  return Buffer.concat([header, host, session, payload])
}

export function encodeStreamOutputBinary(type: StreamBinaryAnsiType, hostId: string, sessionName: string, data: string, options?: { compress?: boolean; threshold?: number }) {
  const raw = Buffer.from(data || '', 'utf8')
  const threshold = options?.threshold ?? 4096
  const force = type === 'output_resync'
  const allow = options?.compress === true && (force || raw.length >= threshold)
  const { payload, gzip } = maybeGzip(raw, allow, force ? 0 : threshold)
  return encodeStreamBinaryFrame(type, hostId, sessionName, payload, gzip)
}

export function encodeStreamCellBinary(type: StreamBinaryCellType, hostId: string, sessionName: string, payload: Buffer, options?: { compress?: boolean; threshold?: number }) {
  const threshold = options?.threshold ?? 4096
  const { payload: body, gzip } = maybeGzip(payload, options?.compress === true, type === 'cell_snapshot' ? 0 : threshold)
  return encodeStreamBinaryFrame(type, hostId, sessionName, body, gzip)
}
