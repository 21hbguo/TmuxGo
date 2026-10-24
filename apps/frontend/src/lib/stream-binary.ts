import { inflate } from 'pako/browser/inflate'
export const STREAM_BINARY_VERSION = 1
export const STREAM_BINARY_VERSION_COMPACT = 2
// v3 = compact + 头带 mirrorSeq(u32)；服务端只会对声明了 mirrorSeq caps 的
// 连接发这个版本，老前端不会收到
export const STREAM_BINARY_VERSION_COMPACT_SEQ = 3
export const STREAM_BINARY_TYPE_OUTPUT = 1
export const STREAM_BINARY_TYPE_RESYNC = 2
export const STREAM_BINARY_TYPE_OUTPUT_GZIP = 3
export const STREAM_BINARY_TYPE_RESYNC_GZIP = 4
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT = 5
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP = 6
export const STREAM_BINARY_TYPE_CELL_DIFF = 7
export const STREAM_BINARY_TYPE_CELL_DIFF_GZIP = 8
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2 = 9
export const STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP = 10
export const STREAM_BINARY_TYPE_CELL_DIFF_V2 = 11
export const STREAM_BINARY_TYPE_CELL_DIFF_V2_GZIP = 12

export type DecodedStreamOutput = {
  type: 'output' | 'output_resync' | 'cell_snapshot' | 'cell_diff' | 'cell_snapshot_v2' | 'cell_diff_v2'
  hostId: string
  sessionName: string
  data: string
  cellPayload?: Uint8Array
  // 服务端 pane 镜像的输出序号（仅 v3 compact 头携带），客户端据此上报增量起点
  mirrorSeq?: number
}

function typeFromCode(typeCode: number): DecodedStreamOutput['type'] | null {
  if (typeCode === STREAM_BINARY_TYPE_OUTPUT || typeCode === STREAM_BINARY_TYPE_OUTPUT_GZIP) return 'output'
  if (typeCode === STREAM_BINARY_TYPE_RESYNC || typeCode === STREAM_BINARY_TYPE_RESYNC_GZIP) return 'output_resync'
  if (typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT || typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP)
    return 'cell_snapshot'
  if (typeCode === STREAM_BINARY_TYPE_CELL_DIFF || typeCode === STREAM_BINARY_TYPE_CELL_DIFF_GZIP) return 'cell_diff'
  if (typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2 || typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP)
    return 'cell_snapshot_v2'
  if (typeCode === STREAM_BINARY_TYPE_CELL_DIFF_V2 || typeCode === STREAM_BINARY_TYPE_CELL_DIFF_V2_GZIP)
    return 'cell_diff_v2'
  return null
}

function isGzipType(typeCode: number) {
  return (
    typeCode === STREAM_BINARY_TYPE_OUTPUT_GZIP ||
    typeCode === STREAM_BINARY_TYPE_RESYNC_GZIP ||
    typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP ||
    typeCode === STREAM_BINARY_TYPE_CELL_DIFF_GZIP ||
    typeCode === STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP ||
    typeCode === STREAM_BINARY_TYPE_CELL_DIFF_V2_GZIP
  )
}

export function gunzipBytes(data: Uint8Array): Uint8Array {
  return inflate(data)
}

export type StreamRouteMap = ReadonlyMap<number, { hostId: string; sessionName: string }>

function finalizePayload(
  kind: DecodedStreamOutput['type'],
  typeCode: number,
  hostId: string,
  sessionName: string,
  payload: Uint8Array,
): DecodedStreamOutput | null {
  const decoder = new TextDecoder()
  let body = payload
  if (isGzipType(typeCode)) {
    try {
      body = gunzipBytes(body)
    } catch {
      return null
    }
  }
  if (kind.startsWith('cell_')) {
    return { type: kind, hostId, sessionName, data: '', cellPayload: body }
  }
  return { type: kind, hostId, sessionName, data: decoder.decode(body) }
}

export function decodeStreamOutputBinary(buffer: ArrayBuffer, routes?: StreamRouteMap): DecodedStreamOutput | null {
  const view = new DataView(buffer)
  if (view.byteLength < 12) return null
  if (view.getUint8(0) !== 0x54 || view.getUint8(1) !== 0x47) return null
  const version = view.getUint8(2)
  const typeCode = view.getUint8(3)
  const kind = typeFromCode(typeCode)
  if (!kind) return null
  if (version === STREAM_BINARY_VERSION_COMPACT || version === STREAM_BINARY_VERSION_COMPACT_SEQ) {
    const routeIdx = view.getUint16(4, true)
    const dataLen = view.getUint32(8, true)
    // v3 在 payloadLen 之后多 4B 镜像序号
    const headerLen = version === STREAM_BINARY_VERSION_COMPACT_SEQ ? 16 : 12
    const total = headerLen + dataLen
    if (view.byteLength < total) return null
    const route = routes?.get(routeIdx)
    // 未知索引：丢弃该帧（不抛错、不断连），见 PROTOCOL.extend.md B.5
    if (!route) return null
    const bytes = new Uint8Array(buffer)
    const payload = bytes.subarray(headerLen, headerLen + dataLen)
    const frame = finalizePayload(kind, typeCode, route.hostId, route.sessionName, payload)
    if (!frame) return null
    if (headerLen === 16) frame.mirrorSeq = view.getUint32(12, true)
    return frame
  }
  if (version !== STREAM_BINARY_VERSION) return null
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
  const payload = bytes.subarray(offset, offset + dataLen)
  return finalizePayload(kind, typeCode, hostId, sessionName, payload)
}
