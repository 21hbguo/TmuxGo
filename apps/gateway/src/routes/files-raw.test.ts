import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'
import test from 'node:test'
import { fileRoutes } from './files.js'
import { getRoots } from '../lib/files/file-roots.js'

async function build() {
  const fastify = Fastify()
  await fastify.register(fileRoutes, { prefix: '/api' })
  return fastify
}

async function workspaceRoot() {
  const roots = await getRoots()
  const root = roots.find((item) => item.label === 'workspace') || roots[0]
  assert.ok(root, 'workspace root exists')
  return root
}

const root = await workspaceRoot()
const textBody = 'ABCDEFGHIJ'
await writeFile(path.join(root.path, 'raw-sample.txt'), textBody)
await writeFile(path.join(root.path, 'raw-zero.txt'), '')
await writeFile(path.join(root.path, 'raw-page.html'), '<h1>hi</h1>')
await writeFile(path.join(root.path, 'raw-icon.svg'), '<svg onload="alert(1)"/>')
await writeFile(path.join(root.path, 'raw-model.bin'), Buffer.from([0, 1, 2, 3]))
await writeFile(path.join(root.path, 'raw-中文 名.pdf'), '%PDF-1.7 fake')
await mkdir(path.join(root.path, 'raw-dir'), { recursive: true })
await writeFile(path.join(root.path, 'raw-dir', 'keep.txt'), 'keep')

function rawUrl(name: string) {
  return `/api/hosts/local/files/raw/${encodeURIComponent(root.id)}/${name.split('/').map(encodeURIComponent).join('/')}`
}

test('raw: full GET returns bytes plus the full validator header set', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({ method: 'GET', url: rawUrl('raw-sample.txt') })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.body, textBody)
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(res.headers['content-length'], String(textBody.length))
    assert.equal(res.headers['accept-ranges'], 'bytes')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin')
    assert.equal(res.headers['cache-control'], 'private, max-age=0, must-revalidate')
    assert.match(String(res.headers.etag), /^W\/"\d+-\d+"$/)
    assert.ok(res.headers['last-modified'])
    assert.match(String(res.headers['content-disposition']), /^inline; filename="raw-sample.txt"; filename\*=UTF-8''/)
    assert.equal(res.headers['content-security-policy'], undefined)
  } finally {
    await fastify.close()
  }
})

test('raw: single range returns 206 with Content-Range and only those bytes', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: rawUrl('raw-sample.txt'),
      headers: { range: 'bytes=2-5' },
    })
    assert.equal(res.statusCode, 206, res.body)
    assert.equal(res.body, 'CDEF')
    assert.equal(res.headers['content-range'], `bytes 2-5/${textBody.length}`)
    assert.equal(res.headers['content-length'], '4')
  } finally {
    await fastify.close()
  }
})

test('raw: unsatisfiable range returns 416 with byte-range header and code', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: rawUrl('raw-sample.txt'),
      headers: { range: 'bytes=999-1200' },
    })
    assert.equal(res.statusCode, 416, res.body)
    assert.equal(res.headers['content-range'], `bytes */${textBody.length}`)
    assert.equal(res.json().code, 'RAW_RANGE_INVALID')
  } finally {
    await fastify.close()
  }
})

test('raw: multi-range requests fall back to the full 200 body', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: rawUrl('raw-sample.txt'),
      headers: { range: 'bytes=0-1,4-5' },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.body, textBody)
    assert.equal(res.headers['content-range'], undefined)
  } finally {
    await fastify.close()
  }
})

test('raw: If-None-Match round-trips to 304 without a body', async () => {
  const fastify = await build()
  try {
    const first = await fastify.inject({ method: 'GET', url: rawUrl('raw-sample.txt') })
    const etag = String(first.headers.etag)
    const res = await fastify.inject({
      method: 'GET',
      url: rawUrl('raw-sample.txt'),
      headers: { 'if-none-match': etag },
    })
    assert.equal(res.statusCode, 304, res.body)
    assert.equal(res.headers.etag, etag)
    assert.equal(res.body, '')
  } finally {
    await fastify.close()
  }
})

test('raw: If-Range mismatch ignores the range and returns the full body', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({
      method: 'GET',
      url: rawUrl('raw-sample.txt'),
      headers: { range: 'bytes=2-5', 'if-range': 'W/"1-1"' },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.body, textBody)
  } finally {
    await fastify.close()
  }
})

test('raw: HEAD returns headers and no body', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({ method: 'HEAD', url: rawUrl('raw-sample.txt') })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.body, '')
    assert.equal(res.headers['content-length'], String(textBody.length))
    assert.equal(res.headers['accept-ranges'], 'bytes')
  } finally {
    await fastify.close()
  }
})

test('raw: zero-byte file is a 200 with Content-Length 0', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({ method: 'GET', url: rawUrl('raw-zero.txt') })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['content-length'], '0')
    assert.equal(res.body, '')
  } finally {
    await fastify.close()
  }
})

test('raw: svg stays blocked with 415 even when downloading', async () => {
  const fastify = await build()
  try {
    for (const url of [rawUrl('raw-icon.svg'), `${rawUrl('raw-icon.svg')}?download=1`]) {
      const res = await fastify.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 415, res.body)
      assert.equal(res.json().code, 'RAW_TYPE_UNSUPPORTED')
    }
  } finally {
    await fastify.close()
  }
})

test('raw: unknown extension is 415 inline but downloadable as octet-stream', async () => {
  const fastify = await build()
  try {
    const inline = await fastify.inject({ method: 'GET', url: rawUrl('raw-model.bin') })
    assert.equal(inline.statusCode, 415, inline.body)
    const download = await fastify.inject({ method: 'GET', url: `${rawUrl('raw-model.bin')}?download=1` })
    assert.equal(download.statusCode, 200, download.body)
    assert.equal(download.headers['content-type'], 'application/octet-stream')
    assert.match(String(download.headers['content-disposition']), /^attachment;/)
  } finally {
    await fastify.close()
  }
})

test('raw: directories are rejected as 400 and missing files as 404', async () => {
  const fastify = await build()
  try {
    const dir = await fastify.inject({ method: 'GET', url: rawUrl('raw-dir') })
    assert.equal(dir.statusCode, 400, dir.body)
    assert.equal(dir.json().code, 'RAW_BAD_REQUEST')
    const missing = await fastify.inject({ method: 'GET', url: rawUrl('nope.txt') })
    assert.equal(missing.statusCode, 404, missing.body)
    assert.equal(missing.json().code, 'RAW_NOT_FOUND')
    // 不回显绝对路径
    assert.ok(!missing.body.includes(root.path))
  } finally {
    await fastify.close()
  }
})

test('raw: html gets the sandbox CSP, pdf does not', async () => {
  const fastify = await build()
  try {
    const html = await fastify.inject({ method: 'GET', url: rawUrl('raw-page.html') })
    assert.equal(html.statusCode, 200, html.body)
    assert.equal(html.headers['content-security-policy'], 'sandbox')
    assert.equal(html.headers['content-type'], 'text/html; charset=utf-8')
    const pdf = await fastify.inject({ method: 'GET', url: rawUrl('raw-中文 名.pdf') })
    assert.equal(pdf.statusCode, 200, pdf.body)
    assert.equal(pdf.headers['content-type'], 'application/pdf')
    assert.equal(pdf.headers['content-security-policy'], undefined)
  } finally {
    await fastify.close()
  }
})

test('raw: non-ASCII filenames are percent-encoded in Content-Disposition', async () => {
  const fastify = await build()
  try {
    const res = await fastify.inject({ method: 'GET', url: rawUrl('raw-中文 名.pdf') })
    assert.equal(res.statusCode, 200, res.body)
    const disposition = String(res.headers['content-disposition'])
    assert.match(disposition, /filename\*=UTF-8''/)
    assert.ok(disposition.includes(encodeURIComponent('raw-中文 名.pdf')))
    // 回退名必须是纯 ASCII，避免 header 里出现原始非 ASCII 字节
    const fallback = /filename="([^"]*)"/.exec(disposition)?.[1] || ''
    assert.match(fallback, /^[\w.-]+$/)
  } finally {
    await fastify.close()
  }
})
