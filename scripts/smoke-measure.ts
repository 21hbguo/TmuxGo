import WebSocket from 'ws'
const GATEWAY = process.env.TMUXGO_GATEWAY || 'ws://127.0.0.1:3001/api/stream'
const SESSION = process.env.TMUXGO_SMOKE_SESSION || 'smoke-bench'
const DURATION_MS = Number(process.env.TMUXGO_SMOKE_DURATION_MS || 30000)
const WORKLOAD = process.env.TMUXGO_SMOKE_WORKLOAD || 'yes "TMUXGO-SMOKE testing stream throughput 0123456789"'
const CELL_OUTPUT = process.env.TMUXGO_SMOKE_CELL === '1'
const ws = new WebSocket(GATEWAY)
ws.binaryType = 'arraybuffer'
let bytesIn = 0
let framesIn = 0
let gzipFrames = 0
let resyncs = 0
let cellSnapshots = 0
let cellDiffs = 0
let fallbacks = 0
let startTime = 0
let attached = false
let timeoutHandle: NodeJS.Timeout | null = null
function finish(label: string) {
  if (timeoutHandle) clearTimeout(timeoutHandle)
  const elapsed = (Date.now() - startTime) / 1000
  const kbps = (bytesIn / 1024) / elapsed
  const result = {
    label,
    elapsed_sec: Number(elapsed.toFixed(2)),
    bytesIn,
    framesIn,
    kbps: Number(kbps.toFixed(2)),
    gzipFrames,
    resyncs,
    cellSnapshots,
    cellDiffs,
    fallbacks,
  }
  console.log(JSON.stringify(result, null, 2))
  try { ws.close() } catch {}
  process.exit(0)
}
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'stream_caps', binaryOutput: true, compressOutput: 'gzip', cellOutput: CELL_OUTPUT }))
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'attach', hostId: 'local', sessionName: SESSION, exclusive: true, cols: 80, rows: 24 }))
  }, 200)
})
ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    bytesIn += buf.length
    framesIn += 1
    if (buf.length >= 4) {
      const typeCode = buf[3]
      if (typeCode === 3 || typeCode === 4 || typeCode === 6 || typeCode === 8) gzipFrames += 1
      if (typeCode === 5 || typeCode === 6) cellSnapshots += 1
      if (typeCode === 7 || typeCode === 8) cellDiffs += 1
    }
    return
  }
  try {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'attached' && !attached) {
      attached = true
      startTime = Date.now()
      ws.send(JSON.stringify({ type: 'input', data: WORKLOAD + '\n' }))
      timeoutHandle = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'input', data: '\x03' }))
        setTimeout(() => finish('smoke'), 500)
      }, DURATION_MS)
    }
    if (msg.type === 'output_resync') resyncs += 1
    if (msg.type === 'error') {
      console.error('Server error:', msg.message)
      finish('error')
    }
  } catch {}
})
ws.on('error', (err) => {
  console.error('WS error:', err.message)
  process.exit(1)
})
setTimeout(() => {
  if (!attached) {
    console.error('Attach timeout')
    process.exit(1)
  }
}, 10000)
