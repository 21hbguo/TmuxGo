import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { createProcessLogStream, getProcessLogPath } from './process-log.js'

test('process log rotates at size limit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-process-log-'))
  const logPath = path.join(dir, 'gateway.log')
  process.env.TMUXGO_PROCESS_LOG = logPath
  try {
    const seed = Buffer.alloc(8 * 1024 * 1024 - 16, 97)
    await writeFile(logPath, seed, { mode: 0o600 })
    const stream = createProcessLogStream({ teeStdout: false })
    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from('hello-after-rotate\n'), (error) => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve) => stream.end(resolve))
    const rotated = await readFile(`${logPath}.1`)
    assert.equal(rotated.length, seed.length)
    const current = await readFile(logPath, 'utf8')
    assert.match(current, /hello-after-rotate/)
    assert.ok((await stat(logPath)).size < 1024)
    assert.equal(getProcessLogPath(), logPath)
  } finally {
    delete process.env.TMUXGO_PROCESS_LOG
    await rm(dir, { recursive: true, force: true })
  }
})
