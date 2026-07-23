export const STREAM_BINARY_VERSION = 1
export const STREAM_BINARY_TYPE_OUTPUT = 1
export const STREAM_BINARY_TYPE_RESYNC = 2

export function encodeStreamOutputBinary(type: 'output' | 'output_resync', hostId: string, sessionName: string, data: string) {
  const host = Buffer.from(hostId || '', 'utf8')
  const session = Buffer.from(sessionName || '', 'utf8')
  const payload = Buffer.from(data || '', 'utf8')
  if (host.length > 0xffff || session.length > 0xffff) throw new Error('stream binary header too large')
  const header = Buffer.allocUnsafe(12)
  header.writeUInt8(0x54, 0)
  header.writeUInt8(0x47, 1)
  header.writeUInt8(STREAM_BINARY_VERSION, 2)
  header.writeUInt8(type === 'output_resync' ? STREAM_BINARY_TYPE_RESYNC : STREAM_BINARY_TYPE_OUTPUT, 3)
  header.writeUInt16LE(host.length, 4)
  header.writeUInt16LE(session.length, 6)
  header.writeUInt32LE(payload.length, 8)
  return Buffer.concat([header, host, session, payload])
}
