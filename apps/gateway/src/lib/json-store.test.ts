import '../test-env.js'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { JsonStore, JsonStoreCorruptionError, JsonStoreLockError } from './json-store.js'

interface Item {
  id: string
}

function makeStore(dir: string) {
  return new JsonStore<Item>(path.join(dir, 'items.json'), {
    key: 'items',
    normalize: (input) => (Array.isArray(input) ? (input as Item[]) : []),
  })
}

test('serializes concurrent read-modify-write updates without losing entries', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeStore(dir)
  const count = 25
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      store.update((items) => ({ items: [...items, { id: `item-${index}` }], result: index })),
    ),
  )
  const items = await store.read()
  assert.equal(items.length, count)
  assert.equal(new Set(items.map((item) => item.id)).size, count)
})

test('recovers from backup when the main file is corrupted', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeStore(dir)
  await store.write([{ id: 'v1' }])
  await store.write([{ id: 'v1' }, { id: 'v2' }])
  // .bak 现在是 v1 版本；破坏主文件后应回到 v1
  await writeFile(file, '{ this is not json', 'utf8')
  const items = await store.read()
  assert.deepEqual(items, [{ id: 'v1' }])
  // 恢复后的下一次写入正常落盘，主文件自愈
  await store.update((list) => ({ items: [...list, { id: 'v3' }], result: null }))
  assert.deepEqual(await store.read(), [{ id: 'v1' }, { id: 'v3' }])
})

test('fails loudly instead of wiping data when all copies are corrupted', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeStore(dir)
  await writeFile(file, '{"items":"not-an-array"}', 'utf8')
  await assert.rejects(() => store.read(), JsonStoreCorruptionError)
  await assert.rejects(() => store.update((items) => ({ items, result: null })), JsonStoreCorruptionError)
  // 未覆盖：坏数据原样保留，可人工恢复
  assert.equal(await readFile(file, 'utf8'), '{"items":"not-an-array"}')
})

test('writes mode 0600 and keeps a readable backup of the previous file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeStore(dir)
  await store.write([{ id: 'a' }])
  await store.write([{ id: 'a' }, { id: 'b' }])
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const backup = JSON.parse(await readFile(`${file}.bak`, 'utf8')) as { items: Item[] }
  assert.deepEqual(backup.items, [{ id: 'a' }])
})

test('reads legacy payload format unchanged', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', items: [{ id: 'legacy' }] }
  await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8')
  const store = makeStore(dir)
  assert.deepEqual(await store.read(), [{ id: 'legacy' }])
})

test('expectedVersion gates reads and stamps the written payload', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new JsonStore<Item>(file, {
    key: 'items',
    expectedVersion: 1,
    normalize: (input) => (Array.isArray(input) ? (input as Item[]) : []),
  })
  // 版本不符的主文件回落 .bak 中的合规版本
  await writeFile(`${file}.bak`, JSON.stringify({ version: 1, items: [{ id: 'from-bak' }] }), 'utf8')
  await writeFile(file, JSON.stringify({ version: 2, items: [{ id: 'newer' }] }), 'utf8')
  assert.deepEqual(await store.read(), [{ id: 'from-bak' }])
  // 双损坏（主版本不符 + .bak 也不符）→ 报错且不清盘
  await writeFile(`${file}.bak`, JSON.stringify({ version: 3, items: [{ id: 'v3' }] }), 'utf8')
  await assert.rejects(store.read(), JsonStoreCorruptionError)
  // 写出的 payload 带声明版本
  const versioned = new JsonStore<Item>(path.join(dir, 'v9.json'), {
    key: 'items',
    expectedVersion: 9,
    normalize: (input) => (Array.isArray(input) ? (input as Item[]) : []),
  })
  await versioned.write([{ id: 'x' }])
  const written = JSON.parse(await readFile(path.join(dir, 'v9.json'), 'utf8')) as { version: number }
  assert.equal(written.version, 9)
})

test('mutate errors propagate without writing and do not poison the queue', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = makeStore(dir)
  await store.write([{ id: 'keep' }])
  await assert.rejects(
    store.update(() => {
      throw new Error('Workspace not found')
    }),
    /Workspace not found/,
  )
  assert.deepEqual(await store.read(), [{ id: 'keep' }])
  await store.update((items) => ({ items: [...items, { id: 'next' }], result: null }))
  assert.deepEqual(await store.read(), [{ id: 'keep' }, { id: 'next' }])
})

test('write failure leaves the previous file and backup recoverable', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const store = makeStore(dir)
  await store.write([{ id: 'a' }])
  await store.write([{ id: 'a' }, { id: 'b' }])
  await chmod(dir, 0o500)
  await assert.rejects(store.write([{ id: 'lost' }]))
  await chmod(dir, 0o700)
  // 主文件仍是上一份完整数据；.bak 保存写前快照（覆盖已存在文件不需目录写权限，
  // 所以可能是 [{a}] 或 [{a},{b}]，两者都是可恢复的有效版本）
  assert.deepEqual(await store.read(), [{ id: 'a' }, { id: 'b' }])
  const backup = JSON.parse(await readFile(`${file}.bak`, 'utf8')) as { items: Item[] }
  assert.ok(backup.items.length >= 1)
  assert.equal(backup.items[0].id, 'a')
})

// 独立 Node 进程跑同一路径 update()：无锁时 read-modify-write 互相覆盖丢写，
// 有锁时全部落盘。worker 脚本写到共享 tmpdir，经 --import tsx 加载 .ts 源码
async function runStoreWorker(dir: string, file: string, tag: string, count: number) {
  const helper = path.join(dir, `worker-${tag}.mjs`)
  const storeUrl = new URL('./json-store.ts', import.meta.url).href
  await writeFile(
    helper,
    `const { JsonStore } = await import(${JSON.stringify(storeUrl)})\n` +
      `const store = new JsonStore(${JSON.stringify(file)}, { key: 'items', normalize: (i) => (Array.isArray(i) ? i : []) })\n` +
      `for (let i = 0; i < ${count}; i++) await store.update((items) => ({ items: [...items, { id: '${tag}-' + i }], result: null }))\n`,
  )
  const child = spawn(process.execPath, ['--import', 'tsx', helper], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // --import tsx 按 cwd 解析依赖：固定仓库根（本文件上溯四级）
    cwd: new URL('../../../../', import.meta.url).pathname,
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
  assert.equal(code, 0, `worker ${tag} failed: ${stderr}`)
}

test('serializes concurrent read-modify-write across independent processes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const perWorker = 10
  await Promise.all([runStoreWorker(dir, file, 'a', perWorker), runStoreWorker(dir, file, 'b', perWorker)])
  const store = makeStore(dir)
  const items = await store.read()
  assert.equal(items.length, perWorker * 2)
  assert.equal(new Set(items.map((item) => item.id)).size, perWorker * 2)
  // 锁文件不残留
  await assert.rejects(stat(`${file}.lock`))
})

test('rejects expectedVersion conflict without clobbering and releases the lock', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const normalize = (input: unknown) => (Array.isArray(input) ? (input as Item[]) : [])
  const v1 = new JsonStore<Item>(file, { key: 'items', expectedVersion: 1, normalize })
  await v1.write([{ id: 'v1' }])
  // 异版本进程/实例读到声明版本不符的文件 → 损坏语义拒绝，绝不静默覆盖
  const v2 = new JsonStore<Item>(file, { key: 'items', expectedVersion: 2, normalize })
  await assert.rejects(
    v2.update((items) => ({ items, result: null })),
    JsonStoreCorruptionError,
  )
  assert.deepEqual(await v1.read(), [{ id: 'v1' }])
  // 失败路径 finally 归还锁：同路径后续写入立即正常
  await assert.rejects(stat(`${file}.lock`))
  await v1.update((items) => ({ items: [...items, { id: 'v2' }], result: null }))
  assert.deepEqual(await v1.read(), [{ id: 'v1' }, { id: 'v2' }])
})

test('reclaims a stale lock left by a dead holder', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 持有者 pid 已退出（spawnSync 返回即死）：锁新鲜也可立即回收
  const dead = spawnSync(process.execPath, ['-e', ''])
  await writeFile(`${file}.lock`, JSON.stringify({ pid: dead.pid, token: 'ghost', createdAt: Date.now() }))
  const store = makeStore(dir)
  await store.write([{ id: 'a' }])
  assert.deepEqual(await store.read(), [{ id: 'a' }])
})

test('reclaims a lock whose mtime exceeded the stale threshold', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  // pid 仍活但 mtime 远超阈值（如 holder 卡死/时钟回拨场景）→ 按 stale 回收
  await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: 'old', createdAt: Date.now() }))
  await utimes(`${file}.lock`, new Date(0), new Date(0))
  const store = makeStore(dir)
  await store.write([{ id: 'b' }])
  assert.deepEqual(await store.read(), [{ id: 'b' }])
})

test('times out on a live held lock, other paths unblock, writes succeed after release', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-store-'))
  const file = path.join(dir, 'items.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const options = {
    key: 'items',
    normalize: (input: unknown) => (Array.isArray(input) ? (input as Item[]) : []),
    lockTimeoutMs: 300,
    lockStaleMs: 60_000,
  }
  // 活 pid + 新鲜 mtime → 非 stale，等待方只能在超时后报可解释错误
  await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: 'held', createdAt: Date.now() }))
  const store = new JsonStore<Item>(file, options)
  await assert.rejects(store.write([{ id: 'blocked' }]), JsonStoreLockError)
  // 不同 store 路径各有独立锁，不被该路径的持锁阻塞
  await new JsonStore<Item>(path.join(dir, 'other.json'), options).write([{ id: 'free' }])
  // 锁释放后同路径立即可写，进程内队列未被超时失败污染
  await rm(`${file}.lock`)
  await store.write([{ id: 'after' }])
  assert.deepEqual(await store.read(), [{ id: 'after' }])
})
