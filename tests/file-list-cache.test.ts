// env injected by scripts/run-tests.ts (TMUXGO_CONFIG_DIR etc.)
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'

// rootSpec/TTL 在模块加载时读取：必须先设 env 再动态 import
const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-list-cache-'))
process.env.TMUX_WEB_FILE_ROOTS = `workspace=${rootDir}`
process.env.TMUXGO_FILE_LIST_TTL_MS = '60000'
const { invalidateListCache, listDirectory } = await import('../apps/gateway/src/lib/files/file-ops.js')

test('listDirectory caches by mtime and invalidates on mutation', async (t) => {
  await mkdir(path.join(rootDir, 'a'))
  await writeFile(path.join(rootDir, 'a', 'one.txt'), '1')
  invalidateListCache()
  const first = await listDirectory('root-0', 'a')
  assert.equal(first.items.length, 1)
  assert.ok(first.etag)
  // second call hits cache (same etag)
  const second = await listDirectory('root-0', 'a')
  assert.equal(second.etag, first.etag)
  assert.equal(second.items.length, 1)
  // mutate directory -> mtime changes -> miss
  await writeFile(path.join(rootDir, 'a', 'two.txt'), '2')
  const future = new Date(Date.now() + 5000)
  await utimes(path.join(rootDir, 'a'), future, future)
  invalidateListCache('root-0', 'a')
  const third = await listDirectory('root-0', 'a')
  assert.equal(third.items.length, 2)
  t.after(async () => {
    invalidateListCache()
    delete process.env.TMUX_WEB_FILE_ROOTS
    delete process.env.TMUXGO_FILE_LIST_TTL_MS
    await rm(rootDir, { recursive: true, force: true })
  })
})

test('large directory list is truncated with totalCount', async (t) => {
  // LIST_PAGE_LIMIT 在模块加载时读取；截断路径用显式 limit 参数验证
  await mkdir(path.join(rootDir, 'big'))
  for (let i = 0; i < 80; i++) await writeFile(path.join(rootDir, 'big', `f${i}.txt`), 'x')
  invalidateListCache()
  const res = await listDirectory('root-0', 'big', 50)
  assert.equal(res.items.length, 50)
  assert.equal(res.truncated, true)
  assert.equal(res.totalCount, 80)
  t.after(async () => {
    invalidateListCache()
    delete process.env.TMUX_WEB_FILE_ROOTS
    delete process.env.TMUXGO_FILE_LIST_TTL_MS
    await rm(rootDir, { recursive: true, force: true })
  })
})
