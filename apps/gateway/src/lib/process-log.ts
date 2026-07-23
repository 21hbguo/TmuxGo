import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'

const MAX_FILE_BYTES = 8 * 1024 * 1024
let captureInstalled = false
let filePathCached = ''
let file: WriteStream | null = null
let size = 0

export function getProcessLogPath() {
  return process.env.TMUXGO_PROCESS_LOG || path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'logs', 'gateway.log')
}

export function isProcessLogEnabled() {
  const value = process.env.TMUXGO_PROCESS_LOG
  return value !== 'off' && value !== '0' && value !== 'false'
}

function ensureFile() {
  if (file) return
  filePathCached = getProcessLogPath()
  mkdirSync(path.dirname(filePathCached), { recursive: true })
  try {
    size = statSync(filePathCached).size
  } catch {
    size = 0
  }
  file = createWriteStream(filePathCached, { flags: 'a', mode: 0o600 })
}

function appendRotated(chunk: unknown) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk))
  if (!buf.length) return
  ensureFile()
  if (size + buf.length >= MAX_FILE_BYTES) {
    try {
      file?.end()
    } catch {}
    file = null
    try {
      renameSync(filePathCached, `${filePathCached}.1`)
    } catch {}
    size = 0
    ensureFile()
  }
  size += buf.length
  file!.write(buf)
}

export function createProcessLogStream(options?: { teeStdout?: boolean }) {
  const tee = options?.teeStdout !== false
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        appendRotated(chunk)
        if (tee) process.stdout.write(chunk)
      } catch {}
      callback()
    },
  })
}

export function installProcessLogCapture() {
  if (captureInstalled || !isProcessLogEnabled()) return false
  captureInstalled = true
  ensureFile()
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name]
    const original = stream.write.bind(stream)
    stream.write = ((chunk: any, encoding?: any, cb?: any) => {
      try {
        appendRotated(chunk)
      } catch {}
      if (typeof encoding === 'function') return original(chunk, encoding)
      return original(chunk, encoding, cb)
    }) as typeof stream.write
  }
  return true
}

export function createFastifyLoggerConfig() {
  const level = process.env.NODE_ENV === 'production' ? 'warn' : 'info'
  if (!isProcessLogEnabled()) return process.env.NODE_ENV === 'production' ? { level } : true
  installProcessLogCapture()
  return { level }
}
