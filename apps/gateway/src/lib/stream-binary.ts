import { gzip, gzipSync, gunzipSync } from 'zlib'

export const STREAM_BINARY_VERSION = 1
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

export type StreamBinaryAnsiType = 'output' | 'output_resync'
export type StreamBinaryCellType = 'cell_snapshot' | 'cell_diff' | 'cell_snapshot_v2' | 'cell_diff_v2'

function typeCodeOf(type: StreamBinaryAnsiType | StreamBinaryCellType, gzip: boolean) {
  if (type === 'output') return gzip ? STREAM_BINARY_TYPE_OUTPUT_GZIP : STREAM_BINARY_TYPE_OUTPUT
  if (type === 'output_resync') return gzip ? STREAM_BINARY_TYPE_RESYNC_GZIP : STREAM_BINARY_TYPE_RESYNC
  if (type === 'cell_snapshot') return gzip ? STREAM_BINARY_TYPE_CELL_SNAPSHOT_GZIP : STREAM_BINARY_TYPE_CELL_SNAPSHOT
  if (type === 'cell_diff') return gzip ? STREAM_BINARY_TYPE_CELL_DIFF_GZIP : STREAM_BINARY_TYPE_CELL_DIFF
  if (type === 'cell_snapshot_v2')
    return gzip ? STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2_GZIP : STREAM_BINARY_TYPE_CELL_SNAPSHOT_V2
  return gzip ? STREAM_BINARY_TYPE_CELL_DIFF_V2_GZIP : STREAM_BINARY_TYPE_CELL_DIFF_V2
}

// zlib.gzip 走线程池回调，不阻塞事件循环；热路径（终端输出 gzip）一律用它，
// gzipSync 仅保留给同步 encode API（测试/非热路径），生产发送不再调用
function gzipAsync(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(data, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

export function gzipPayload(data: Buffer) {
  return gzipSync(data)
}

export async function gzipPayloadAsync(data: Buffer) {
  return gzipAsync(data)
}

export function gunzipPayload(data: Buffer) {
  return gunzipSync(data)
}

// 与 maybeGzip 同源的前置判断：调用方据此同步分流——需要压缩的帧进异步
// 压缩+发送队列，不需要的走同步快路径，避免仅为判断是否压缩而空转微任务
export function shouldMaybeGzip(dataLen: number, enabled: boolean, threshold: number, force = false) {
  if (!enabled) return false
  if (dataLen <= 0) return false
  if (!force && threshold > 0 && dataLen < threshold) return false
  return true
}

export function maybeGzip(data: Buffer, enabled: boolean, threshold: number) {
  if (!enabled) return { payload: data, gzip: false }
  if (threshold > 0 && data.length < threshold) return { payload: data, gzip: false }
  if (!data.length) return { payload: data, gzip: false }
  const compressed = gzipSync(data)
  if (compressed.length >= data.length) return { payload: data, gzip: false }
  return { payload: compressed, gzip: true }
}

// 异步版 maybeGzip：阈值/开关判断仍同步短路；仅真正压缩时进线程池。
// gzip 失败不抛——failed 置位、回退明文，由调用方记 metric，保证不断连不丢帧
export async function maybeGzipAsync(data: Buffer, enabled: boolean, threshold: number) {
  if (!enabled) return { payload: data, gzip: false, failed: false }
  if (threshold > 0 && data.length < threshold) return { payload: data, gzip: false, failed: false }
  if (!data.length) return { payload: data, gzip: false, failed: false }
  let compressed: Buffer
  try {
    compressed = await gzipAsync(data)
  } catch {
    return { payload: data, gzip: false, failed: true }
  }
  // 压缩后不小于明文（高熵负载）：按协议回退明文帧
  if (compressed.length >= data.length) return { payload: data, gzip: false, failed: false }
  return { payload: compressed, gzip: true, failed: false }
}

export function encodeStreamBinaryFrame(
  type: StreamBinaryAnsiType | StreamBinaryCellType,
  hostId: string,
  sessionName: string,
  payload: Buffer,
  gzip = false,
) {
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

export function encodeStreamOutputBinary(
  type: StreamBinaryAnsiType,
  hostId: string,
  sessionName: string,
  data: string,
  options?: { compress?: boolean; threshold?: number },
) {
  const raw = Buffer.from(data || '', 'utf8')
  const threshold = options?.threshold ?? 4096
  const force = type === 'output_resync'
  const allow = options?.compress === true && (force || raw.length >= threshold)
  const { payload, gzip } = maybeGzip(raw, allow, force ? 0 : threshold)
  return encodeStreamBinaryFrame(type, hostId, sessionName, payload, gzip)
}

// 异步输出帧编码：阈值判断与同步版一致（resync 无视阈值强制尝试），
// 仅压缩本身改为线程池；gzipFailed=true 表示已回退明文，调用方据此记 metric
export async function encodeStreamOutputBinaryAsync(
  type: StreamBinaryAnsiType,
  hostId: string,
  sessionName: string,
  data: string,
  options?: { compress?: boolean; threshold?: number },
): Promise<{ frame: Buffer; gzipFailed: boolean }> {
  const raw = Buffer.from(data || '', 'utf8')
  const threshold = options?.threshold ?? 4096
  const force = type === 'output_resync'
  const allow = options?.compress === true && (force || raw.length >= threshold)
  const { payload, gzip, failed } = await maybeGzipAsync(raw, allow, force ? 0 : threshold)
  return { frame: encodeStreamBinaryFrame(type, hostId, sessionName, payload, gzip), gzipFailed: failed }
}

export function encodeStreamCellBinary(
  type: StreamBinaryCellType,
  hostId: string,
  sessionName: string,
  payload: Buffer,
  options?: { compress?: boolean; threshold?: number },
) {
  const threshold = options?.threshold ?? 4096
  const isSnapshot = type === 'cell_snapshot' || type === 'cell_snapshot_v2'
  const { payload: body, gzip } = maybeGzip(payload, options?.compress === true, isSnapshot ? 0 : threshold)
  return encodeStreamBinaryFrame(type, hostId, sessionName, body, gzip)
}

// 异步 cell 帧编码：snapshot 无视阈值强制尝试、diff 走阈值，规则与同步版一致
export async function encodeStreamCellBinaryAsync(
  type: StreamBinaryCellType,
  hostId: string,
  sessionName: string,
  payload: Buffer,
  options?: { compress?: boolean; threshold?: number },
): Promise<{ frame: Buffer; gzipFailed: boolean }> {
  const threshold = options?.threshold ?? 4096
  const isSnapshot = type === 'cell_snapshot' || type === 'cell_snapshot_v2'
  const {
    payload: body,
    gzip,
    failed,
  } = await maybeGzipAsync(payload, options?.compress === true, isSnapshot ? 0 : threshold)
  return { frame: encodeStreamBinaryFrame(type, hostId, sessionName, body, gzip), gzipFailed: failed }
}
