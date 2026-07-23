import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'

const MAX_FILE_BYTES = 8 * 1024 * 1024

export function getProcessLogPath() {
  return process.env.TMUXGO_PROCESS_LOG || path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'logs', 'gateway.log')
}

export function isProcessLogEnabled() {
  const value = process.env.TMUXGO_PROCESS_LOG
  return value !== 'off' && value !== '0' && value !== 'false'
}

export function createProcessLogStream(options?: { teeStdout?: boolean }) {
  const filePath = getProcessLogPath()
  mkdirSync(path.dirname(filePath), { recursive: true })
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {}
  let file: WriteStream = createWriteStream(filePath, { flags: 'a', mode: 0o600 })
  const tee = options?.teeStdout !== false
  const rotateIfNeeded = (nextBytes: number) => {
    if (size + nextBytes < MAX_FILE_BYTES) return
    try {
      file.end()
    } catch {}
    try {
      renameSync(filePath, `${filePath}.1`)
    } catch {}
    file = createWriteStream(filePath, { flags: 'a', mode: 0o600 })
    size = 0
  }
  return new Writable({
    write(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      rotateIfNeeded(buf.length)
      size += buf.length
      if (tee) {
        try {
          process.stdout.write(buf)
        } catch {}
      }
      file.write(buf, callback)
    },
  })
}

export function createFastifyLoggerConfig() {
  const level = process.env.NODE_ENV === 'production' ? 'warn' : 'info'
  if (!isProcessLogEnabled()) return process.env.NODE_ENV === 'production' ? { level } : true
  return {
    level,
    stream: createProcessLogStream({ teeStdout: process.env.TMUXGO_PROCESS_LOG_STDOUT !== '0' && process.env.TMUXGO_PROCESS_LOG_STDOUT !== 'false' }),
  }
}
