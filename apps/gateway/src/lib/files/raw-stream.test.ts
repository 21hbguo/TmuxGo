import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { limitBytes } from './raw-stream.js'

async function collect(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

test('limitBytes: truncates a longer stream to the exact byte count', async () => {
  const source = Readable.from([Buffer.alloc(64, 1), Buffer.alloc(64, 2)])
  const out = await collect(limitBytes(source, 100))
  assert.equal(out.length, 100)
  assert.deepEqual(out.subarray(0, 64), Buffer.alloc(64, 1))
  assert.deepEqual(out.subarray(64), Buffer.alloc(36, 2))
})

test('limitBytes: passes a shorter stream through untouched', async () => {
  const payload = Buffer.from('hello range')
  const out = await collect(limitBytes(Readable.from([payload]), 1024))
  assert.deepEqual(out, payload)
})

test('limitBytes: zero limit yields an empty stream', async () => {
  const out = await collect(limitBytes(Readable.from([Buffer.from('abc')]), 0))
  assert.equal(out.length, 0)
})

test('limitBytes: handles string chunks', async () => {
  const out = await collect(limitBytes(Readable.from(['abc', 'def']), 4))
  assert.equal(out.toString(), 'abcd')
})

test('limitBytes: destroys the upstream once the limit is hit', async () => {
  let produced = 0
  let destroyed = false
  const source = new Readable({
    read() {
      produced += 1
      this.push(Buffer.alloc(1024, 7))
    },
    destroy(error, callback) {
      destroyed = true
      callback(error)
    },
  })
  const out = await collect(limitBytes(source, 4096))
  assert.equal(out.length, 4096)
  assert.equal(destroyed, true)
  // 上游会按 highWaterMark 预读（Node 会把缓冲拼成一个大 chunk），
  // 这里只要求「有限预读后停止」，而不是无限拉流。
  assert.ok(produced < 256, `produced ${produced} chunks`)
})
