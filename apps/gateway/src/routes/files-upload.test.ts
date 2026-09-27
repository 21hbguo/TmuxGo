import '../test-env.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import test from 'node:test'
import { fileRoutes } from './files.js'
import { getRoots } from '../lib/files/file-roots.js'

const BOUNDARY = '----tmuxgo-test-boundary'

interface MultipartFile {
  filename: string
  data: Buffer
  contentType?: string
}

// 手工拼 multipart：字段必须排在文件之前——路由按流序读 parts，
// 文件先到会因缺 targetRootId 被拒
function multipartBody(fields: Record<string, string>, files: MultipartFile[]) {
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields))
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
      ),
    )
    chunks.push(file.data)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

async function build(limits?: { fileSize?: number; files?: number }) {
  const fastify = Fastify()
  await fastify.register(multipart, { limits })
  await fastify.register(fileRoutes, { prefix: '/api' })
  return fastify
}

async function workspaceRoot() {
  const roots = await getRoots()
  const root = roots.find((item) => item.label === 'workspace') || roots[0]
  assert.ok(root, 'workspace root exists')
  return root
}

test('upload accepts arbitrary file types (binary, no-ext, archive, pdf)', async () => {
  const fastify = await build()
  try {
    const root = await workspaceRoot()
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x00, 0xde, 0xad])
    const { payload, headers } = multipartBody({ targetRootId: root.id, targetPath: 'up-test' }, [
      { filename: 'model.gguf', data: binary },
      { filename: 'archive.7z', data: Buffer.from('7z-archive-bytes') },
      { filename: 'noext', data: Buffer.from('plain bytes without extension') },
      { filename: 'doc.pdf', data: Buffer.from('%PDF-1.7 fake') },
    ])
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers,
      payload,
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { files: { name: string; absolutePath: string }[] }
    assert.deepEqual(body.files.map((f) => f.name).sort(), ['archive.7z', 'doc.pdf', 'model.gguf', 'noext'])
    for (const file of body.files) assert.ok(existsSync(file.absolutePath), file.name)
    const landed = path.join(root.path, 'up-test', 'model.gguf')
    assert.ok(existsSync(landed))
    assert.equal(Buffer.from(binary).length, 8)
  } finally {
    await fastify.close()
  }
})

test('upload sanitizes traversal filenames and rejects bare dot names', async () => {
  const fastify = await build()
  try {
    const root = await workspaceRoot()
    const { payload, headers } = multipartBody({ targetRootId: root.id, targetPath: 'up-test' }, [
      { filename: '../../etc/passwd-evil.txt', data: Buffer.from('x') },
    ])
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers,
      payload,
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { files: { name: string; absolutePath: string }[] }
    // basename 消毒：穿越段被剥掉，落到目标目录内
    assert.equal(body.files[0].name, 'passwd-evil.txt')
    assert.ok(body.files[0].absolutePath.startsWith(path.join(root.path, 'up-test')))
    assert.ok(!existsSync('/etc/passwd-evil.txt'))

    const bad = multipartBody({ targetRootId: root.id, targetPath: 'up-test' }, [
      { filename: '..', data: Buffer.from('x') },
    ])
    const badRes = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers: bad.headers,
      payload: bad.payload,
    })
    assert.equal(badRes.statusCode, 400)
    assert.match(badRes.json().message, /Invalid file name/)
  } finally {
    await fastify.close()
  }
})

test('upload rejects missing target root as 400 and honors multipart limits', async () => {
  const fastify = await build({ fileSize: 16, files: 1 })
  try {
    const missing = multipartBody({}, [{ filename: 'a.bin', data: Buffer.from('x') }])
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers: missing.headers,
      payload: missing.payload,
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /Missing target root/)

    const root = await workspaceRoot()
    const tooLarge = multipartBody({ targetRootId: root.id, targetPath: '' }, [
      { filename: 'big.bin', data: Buffer.alloc(1024) },
    ])
    const largeRes = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers: tooLarge.headers,
      payload: tooLarge.payload,
    })
    assert.equal(largeRes.statusCode, 413)
    assert.match(largeRes.json().message, /too large/i)

    const tooMany = multipartBody({ targetRootId: root.id, targetPath: '' }, [
      { filename: 'a.bin', data: Buffer.from('a') },
      { filename: 'b.bin', data: Buffer.from('b') },
    ])
    const manyRes = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers: tooMany.headers,
      payload: tooMany.payload,
    })
    assert.equal(manyRes.statusCode, 413)
  } finally {
    await fastify.close()
  }
})

test('image preview endpoint refuses svg (no inline script execution)', async () => {
  const fastify = await build()
  try {
    const root = await workspaceRoot()
    const { payload, headers } = multipartBody({ targetRootId: root.id, targetPath: 'up-test' }, [
      { filename: 'icon.svg', data: Buffer.from('<svg onload="alert(1)"/>') },
    ])
    const up = await fastify.inject({
      method: 'POST',
      url: '/api/hosts/local/files/upload',
      headers,
      payload,
    })
    assert.equal(up.statusCode, 200, up.body)
    // 上传本身放行；但 inline 图片预览拒绝 svg → 前端只能文本预览或下载
    const preview = await fastify.inject({
      method: 'GET',
      url: `/api/hosts/local/files/image?root=${encodeURIComponent(root.id)}&path=${encodeURIComponent('up-test/icon.svg')}`,
    })
    assert.equal(preview.statusCode, 400)
    assert.equal(preview.json().code, 'IMAGE_TYPE_UNSUPPORTED')
  } finally {
    await fastify.close()
  }
})
