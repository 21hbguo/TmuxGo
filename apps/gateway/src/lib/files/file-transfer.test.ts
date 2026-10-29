import '../../test-env.js'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import {
  cleanupExpiredDownloadArtifacts,
  cleanupExpiredStagedUploads,
  createRateLimitStream,
  getDownloadArtifactDir,
  getDownloadArtifactPath,
  getDownloadStream,
  getImageMimeType,
  normalizeUploadRateLimitKBps,
  readStoredUploadRateLimitKBps,
  resolveDefaultUploadTarget,
  resolveDownloadRateLimitKBps,
  resolveUploadDestination,
  runBackgroundDownloadTask,
  runBackgroundUploadTask,
  sanitizeUploadFileName,
  stageUploadFile,
  writeRemoteUpload,
} from './file-transfer.js'
import { getRoots, resolveInside } from './file-roots.js'
import type { TaskExecutionContext, TaskManager } from '../task-manager.js'
import { upsertRemoteHost } from '../hosts.js'
import { installShims } from '../../test-shims.js'

// 统一把异步 iterable 的流收成 Buffer（下载/限速断言都要比字节，不看文本）
async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

// TaskExecutionContext 桩：把 progress/log/checkpoint 全部记录下来，供状态迁移断言
function makeContext(signal = new AbortController().signal) {
  const progress: { percent: number | null; speed: number | null }[] = []
  const logs: string[] = []
  let checkpoints = 0
  const context: TaskExecutionContext = {
    signal,
    appendLog: (value) => logs.push(value),
    setProgress: (percent, speed) => progress.push({ percent, speed: speed ?? null }),
    checkpoint: () => {
      checkpoints += 1
    },
  }
  return { context, progress, logs, checkpoints: () => checkpoints }
}

// 写临时 config 目录：staging/artifacts 都挂在 TMUXGO_CONFIG_DIR 下
async function withConfigDir(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-file-transfer-config-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  const previousPrefs = process.env.TMUXGO_PREFERENCES_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  process.env.TMUXGO_PREFERENCES_DIR = path.join(dir, 'preferences')
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    if (previousPrefs === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
    else process.env.TMUXGO_PREFERENCES_DIR = previousPrefs
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function withTempDir(t: TestContext, prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tmuxgo-file-transfer-${prefix}-`))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function setEnv(t: TestContext, vars: Record<string, string>) {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

// ---- 文件名清洗：这是唯一挡在用户文件名和落盘路径之间的逻辑 ----

test('sanitizeUploadFileName strips directories and rejects empty/dot names', () => {
  assert.equal(sanitizeUploadFileName('a/b/c.txt'), 'c.txt')
  assert.equal(sanitizeUploadFileName('/etc/passwd'), 'passwd')
  assert.equal(sanitizeUploadFileName('  spaced.txt  '), 'spaced.txt')
  // NUL 会让下游 fs 调用抛 EINVAL，先清掉而不是留到落盘阶段
  assert.equal(sanitizeUploadFileName('a\0b.txt'), 'ab.txt')
  assert.equal(sanitizeUploadFileName('a\0'), 'a')
  for (const invalid of ['', '   ', '.', '..', 'dir/../']) {
    assert.throws(() => sanitizeUploadFileName(invalid), /Invalid file name/, JSON.stringify(invalid))
  }
  // POSIX 下反斜杠不是分隔符：按单段文件名保留（不会造成穿越，但也确实没被清洗）
  assert.equal(sanitizeUploadFileName('..\\evil.txt'), '..\\evil.txt')
  // 没有长度上限：当前行为是原样返回，超长名由文件系统兜底
  const longName = `${'a'.repeat(300)}.txt`
  assert.equal(sanitizeUploadFileName(longName), longName)
})

test('normalizeUploadRateLimitKBps falls back and clamps to the supported range', () => {
  // 非法值一律回退默认值，绝不让 NaN 流进限速器（bytesPerSecond 会变 NaN 直接卡死流）
  for (const invalid of [undefined, null, {}, 'abc', NaN, Infinity, -Infinity]) {
    assert.equal(normalizeUploadRateLimitKBps(invalid), 5120, String(invalid))
  }
  // 空字符串走 Number('') = 0 的路径，被夹到 1 KB/s 而不是回退默认值（与未设置区分）
  assert.equal(normalizeUploadRateLimitKBps(''), 1)
  assert.equal(normalizeUploadRateLimitKBps(-5), 1)
  assert.equal(normalizeUploadRateLimitKBps(0), 1)
  assert.equal(normalizeUploadRateLimitKBps(0.4), 1)
  assert.equal(normalizeUploadRateLimitKBps(2048), 2048)
  assert.equal(normalizeUploadRateLimitKBps('2048'), 2048)
  assert.equal(normalizeUploadRateLimitKBps(2048.6), 2049)
  // 上限 10 MB/s：超出按上限截断而不是拒绝请求
  assert.equal(normalizeUploadRateLimitKBps(20 * 1024), 10240)
  assert.equal(normalizeUploadRateLimitKBps('999999'), 10240)
})

test('rate limit preferences fall back to defaults for missing or broken files', async (t) => {
  const configDir = await withConfigDir(t)
  assert.equal(await readStoredUploadRateLimitKBps(), 5120)
  await mkdir(path.join(configDir, 'preferences'), { recursive: true })
  await writeFile(path.join(configDir, 'preferences', 'default.json'), '{ broken json')
  assert.equal(await readStoredUploadRateLimitKBps(), 5120)
  await writeFile(
    path.join(configDir, 'preferences', 'default.json'),
    JSON.stringify({ uploadRateLimitKBps: 777, downloadRateLimitKBps: 0 }),
  )
  assert.equal(await readStoredUploadRateLimitKBps(), 777)
  // 存盘里的 0 被夹到 1 KB/s（不是回退默认，也不是「不限速」）
  assert.equal(await resolveDownloadRateLimitKBps(undefined), 1)
  await writeFile(path.join(configDir, 'preferences', 'default.json'), JSON.stringify({ downloadRateLimitKBps: 2048 }))
  assert.equal(await resolveDownloadRateLimitKBps(undefined), 2048)
  // 查询参数优先于存盘配置
  assert.equal(await resolveDownloadRateLimitKBps('4096'), 4096)
  assert.equal(await resolveDownloadRateLimitKBps(-1), 1)
  assert.equal(await resolveDownloadRateLimitKBps('not-a-number'), 2048)
})

test('resolveUploadDestination renames conflicting files with a counter suffix', async (t) => {
  const dir = await withTempDir(t, 'conflict')
  assert.deepEqual(await resolveUploadDestination(dir, 'a.txt'), {
    candidateName: 'a.txt',
    candidatePath: path.join(dir, 'a.txt'),
  })
  await writeFile(path.join(dir, 'a.txt'), 'first')
  assert.equal((await resolveUploadDestination(dir, 'a.txt')).candidateName, 'a (1).txt')
  await writeFile(path.join(dir, 'a (1).txt'), 'second')
  assert.equal((await resolveUploadDestination(dir, 'a.txt')).candidateName, 'a (2).txt')
  // 无扩展名的点文件按 path.parse 的语义保留成 '.env (1)'
  await writeFile(path.join(dir, '.env'), 'x')
  assert.equal((await resolveUploadDestination(dir, '.env')).candidateName, '.env (1)')
})

test('resolveUploadDestination gives up after 1000 conflicts instead of looping forever', async (t) => {
  const dir = await withTempDir(t, 'conflict-cap')
  await Promise.all([
    writeFile(path.join(dir, 'x.txt'), ''),
    ...Array.from({ length: 999 }, (_, index) => writeFile(path.join(dir, `x (${index + 1}).txt`), '')),
  ])
  await assert.rejects(resolveUploadDestination(dir, 'x.txt'), /Too many conflicting files/)
})

test('resolveInside refuses lexical traversal but follows symlinks (c57eeba)', async (t) => {
  // 上传目标来自 rootId+相对路径，词法越界是这里唯一要挡的东西：
  // c57eeba 起刻意不做 realpath 检查——home -> /data 这类链接目录要能进（文件管理器语义），
  // 所以「链接指向根外」不再算逃逸，只有 '..' 段和绝对路径越界才拒绝
  const roots = await getRoots()
  const root = roots[0]
  const outside = await withTempDir(t, 'outside')
  await assert.rejects(resolveInside(root.id, '../outside'), /Path escapes root/)
  await symlink(outside, path.join(root.path, 'escape-link'))
  t.after(async () => {
    await rm(path.join(root.path, 'escape-link'), { force: true })
  })
  // 链接原地跟随：解析结果就是链接路径本身，不再 realpath 展开
  const linked = await resolveInside(root.id, 'escape-link')
  assert.equal(linked.absolutePath, path.join(root.path, 'escape-link'))
  const inside = await resolveInside(root.id, '.')
  assert.equal(inside.absolutePath, root.path)
})

// ---- 限速流：限速失效等于上传打满出口带宽，工程上是「静默变慢/变快」而不是报错 ----

test('createRateLimitStream throttles throughput but keeps every byte in order', async () => {
  const payload = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251))
  const startedAt = Date.now()
  // 一次性灌入 2 KB，逼限速器自己切块：预算 1 KB 立即放行，其余按 1 KB/s 补
  const output = await collectStream(Readable.from([payload]).pipe(createRateLimitStream(1)))
  const elapsed = Date.now() - startedAt
  assert.deepEqual(output, payload)
  // 只给下界断言，避免受机器负载影响而抖动
  assert.ok(elapsed >= 800, `expected throttling, finished in ${elapsed}ms`)
})

test('stageUploadFile writes a private staging file and reports its size', async (t) => {
  const configDir = await withConfigDir(t)
  const payload = Buffer.from('staged-payload')
  const source = Readable.from([payload])
  const staged = await stageUploadFile(source, 'payload.txt', 10240)
  assert.equal(staged.name, 'payload.txt')
  assert.equal(staged.size, payload.length)
  assert.equal(path.dirname(staged.stagedPath), path.join(configDir, 'upload-staging'))
  // staging 目录 0o700、文件 0o600：上传中转内容不得被同机其他用户读取
  assert.equal((await stat(path.join(configDir, 'upload-staging'))).mode & 0o777, 0o700)
  assert.equal((await stat(staged.stagedPath)).mode & 0o777, 0o600)
  assert.deepEqual(await readFile(staged.stagedPath), payload)
})

test('cleanupExpiredStagedUploads removes only entries past the TTL', async (t) => {
  const configDir = await withConfigDir(t)
  const stagingDir = path.join(configDir, 'upload-staging')
  await mkdir(stagingDir, { recursive: true })
  setEnv(t, { TMUXGO_TMP_TTL_MS: String(60 * 60 * 1000) })
  const now = Date.now()
  const stale = path.join(stagingDir, 'stale')
  const fresh = path.join(stagingDir, 'fresh')
  const staleDir = path.join(stagingDir, 'stale-dir')
  await writeFile(stale, 'stale')
  await writeFile(fresh, 'fresh')
  await mkdir(staleDir)
  await writeFile(path.join(staleDir, 'nested'), 'nested')
  await Promise.all([
    utimes(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000)),
    utimes(fresh, new Date(now), new Date(now)),
    utimes(staleDir, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000)),
  ])
  await cleanupExpiredStagedUploads(now)
  await assert.rejects(stat(stale), /ENOENT/)
  // 目录条目也按 TTL 递归清理（中断的上传可能留下目录）
  await assert.rejects(stat(staleDir), /ENOENT/)
  assert.equal((await stat(fresh)).isFile(), true)
  // 目录不存在时静默返回，不得抛错打断定时器
  await rm(stagingDir, { recursive: true, force: true })
  await cleanupExpiredStagedUploads(now)
})

// ---- 下载产物清理：TTL / 数量 / 字节三阈值 + 任务引用保护 ----

test('cleanupExpiredDownloadArtifacts keeps artifacts that a recent task still references', async (t) => {
  await withConfigDir(t)
  const artifactDir = getDownloadArtifactDir()
  await mkdir(artifactDir, { recursive: true })
  const protectedId = '11111111-1111-4111-8111-111111111111'
  const now = Date.now()
  const stale = path.join(artifactDir, '22222222-2222-4222-8222-222222222222')
  const protectedPath = path.join(artifactDir, protectedId)
  const temporary = path.join(
    artifactDir,
    '33333333-3333-4333-8333-333333333333.tmp-44444444-4444-4444-8444-444444444444',
  )
  await Promise.all([writeFile(stale, 'stale'), writeFile(protectedPath, 'keep'), writeFile(temporary, 'tmp')])
  const old = new Date(now - 25 * 60 * 60 * 1000)
  await Promise.all([utimes(stale, old, old), utimes(protectedPath, old, old), utimes(temporary, old, old)])
  const tasks = {
    list: () => [
      {
        type: 'file-download',
        status: 'success',
        finishedAt: new Date(now - 60_000).toISOString(),
        result: { downloadUrl: `/api/hosts/local/files/download-tasks/${protectedId}` },
      },
      // 非下载任务 / 失败任务即使 URL 形状相同也不该保护
      {
        type: 'file-upload',
        status: 'success',
        finishedAt: new Date(now - 60_000).toISOString(),
        result: { downloadUrl: `/api/hosts/local/files/download-tasks/55555555-5555-4555-8555-555555555555` },
      },
      {
        type: 'file-download',
        status: 'error',
        finishedAt: new Date(now - 60_000).toISOString(),
        result: { downloadUrl: `/api/hosts/local/files/download-tasks/66666666-6666-4666-8666-666666666666` },
      },
    ],
  } as unknown as TaskManager
  await cleanupExpiredDownloadArtifacts(now, tasks)
  // 过期未被引用 → 删；过期但被最近任务引用 → 留；半成品 .tmp-* 过期 → 删
  await assert.rejects(stat(stale), /ENOENT/)
  assert.equal((await stat(protectedPath)).isFile(), true)
  await assert.rejects(stat(temporary), /ENOENT/)
  assert.equal(path.basename(getDownloadArtifactDir()), 'download-artifacts')
  // 非法 artifactId 不得拼出目录外路径
  assert.throws(() => getDownloadArtifactPath('../../etc/passwd'), /Invalid download artifact/)
  assert.equal(getDownloadArtifactPath(protectedId), path.join(artifactDir, protectedId))
})

test('cleanupExpiredDownloadArtifacts trims by count and bytes, oldest first', async (t) => {
  await withConfigDir(t)
  const artifactDir = getDownloadArtifactDir()
  await mkdir(artifactDir, { recursive: true })
  setEnv(t, { TMUXGO_DOWNLOAD_ARTIFACT_MAX_COUNT: '2', TMUXGO_DOWNLOAD_ARTIFACT_MAX_BYTES: '1024' })
  const now = Date.now()
  const names = ['a', 'b', 'c', 'd']
  for (const [index, name] of names.entries()) {
    const file = path.join(artifactDir, name)
    await writeFile(file, 'x'.repeat(100))
    // mtime 依次变新：a 最旧
    const stamp = new Date(now - (names.length - index) * 1000)
    await utimes(file, stamp, stamp)
  }
  await cleanupExpiredDownloadArtifacts(now, { list: () => [] } as unknown as TaskManager)
  await assert.rejects(stat(path.join(artifactDir, 'a')), /ENOENT/)
  await assert.rejects(stat(path.join(artifactDir, 'b')), /ENOENT/)
  assert.equal((await stat(path.join(artifactDir, 'c'))).isFile(), true)
  assert.equal((await stat(path.join(artifactDir, 'd'))).isFile(), true)

  // 字节阈值：把上限压到 150，四个 100 字节文件只能留最旧被淘汰后的两个以内
  setEnv(t, { TMUXGO_DOWNLOAD_ARTIFACT_MAX_BYTES: '150', TMUXGO_DOWNLOAD_ARTIFACT_MAX_COUNT: '10' })
  await cleanupExpiredDownloadArtifacts(now, { list: () => [] } as unknown as TaskManager)
  assert.equal((await stat(path.join(artifactDir, 'd'))).isFile(), true)
  await assert.rejects(stat(path.join(artifactDir, 'c')), /ENOENT/)
})

// ---- 下载流与 MIME 白名单 ----

test('getImageMimeType only maps raster extensions and never svg', () => {
  assert.equal(getImageMimeType('/tmp/A.PNG'), 'image/png')
  assert.equal(getImageMimeType('photo.jpeg'), 'image/jpeg')
  assert.equal(getImageMimeType('icon.ico'), 'image/x-icon')
  // svg 可内联执行脚本，必须在白名单外，只能按文本/下载处理
  assert.equal(getImageMimeType('logo.svg'), '')
  assert.equal(getImageMimeType('notes.txt'), '')
  assert.equal(getImageMimeType('noext'), '')
})

test('getDownloadStream streams local files from the requested offset and zips directories', async (t) => {
  const dir = await withTempDir(t, 'download-local')
  const file = path.join(dir, 'data.bin')
  await writeFile(file, 'abcdefghij')
  assert.equal((await collectStream(await getDownloadStream('local', file, false))).toString(), 'abcdefghij')
  // 断点续传：offset 之后的内容才是客户端缺的那段
  assert.equal((await collectStream(await getDownloadStream('local', file, false, undefined, 4))).toString(), 'efghij')
  await mkdir(path.join(dir, 'folder'))
  await writeFile(path.join(dir, 'folder', 'inner.txt'), 'inner')
  const archive = await collectStream(await getDownloadStream('local', path.join(dir, 'folder'), true))
  // zip 目录流的可判定特征就是本地文件头 'PK\x03\x04'
  assert.equal(archive.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004')
  assert.ok(archive.includes(Buffer.from('inner.txt')))
})

test('getDownloadStream never fabricates content for an unreadable local file', async (t) => {
  const dir = await withTempDir(t, 'download-missing')
  const stream = await getDownloadStream('local', path.join(dir, 'missing.bin'), false)
  // 已知缺陷（已上报 lead）：python 的 stderr 在 stdout 结束后才触发 child close，
  // 此时 destroy(error) 已无效，现状是静默返回 0 字节。修复后应转为 reject，
  // 这里两种都接受——只锁死「不许凭空产生内容」这条不变量
  const outcome = await collectStream(stream).then(
    (buffer) => ({ bytes: buffer.length }),
    (error: Error) => ({ error: error.message }),
  )
  if ('error' in outcome) assert.match(outcome.error, /No such file or directory|Download failed/)
  else assert.equal(outcome.bytes, 0)
})

// ---- 远端写：命令拼接与限速/进度管道的真实字节 ----

test('writeRemoteUpload streams bytes through ssh with a safely quoted remote path', async (t) => {
  const configDir = await withConfigDir(t)
  await upsertRemoteHost({ id: 'remote-write', address: '192.0.2.110', user: 'dev', port: 22 })
  const capture = path.join(configDir, 'captured.bin')
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  setEnv(t, { SHIM_CAPTURE_FILE: capture, SHIM_SSH_EXIT: '0' })
  const payload = Buffer.from('remote-payload-content')
  const source = Readable.from([payload])
  const reported: number[] = []
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      reported.push(chunk.length)
      callback(null, chunk)
    },
  })
  // 路径带单引号：命令走 sh -lc，未转义会把远端命令截断成两条
  await writeRemoteUpload('remote-write', `/tmp/it's dir/файл.bin`, source, 10240, undefined, progress)
  assert.deepEqual(await readFile(capture), payload)
  assert.deepEqual(reported, [payload.length])
  // argv 日志按行切分会截断含换行的远端脚本，这里直接看原始日志
  const rawLog = await readFile(shims.log, 'utf8')
  assert.ok(rawLog.includes(`'/tmp/it'\\''s dir/файл.bin'`), 'single quotes in the remote path must be escaped')
  assert.ok(rawLog.includes('-T'), 'remote transfer must not allocate a tty')
  assert.ok(rawLog.includes('__TMUXGO_NO_PYTHON__'), 'remote script must fail loudly when python is missing')
})

test('writeRemoteUpload reports normalized remote failures instead of hanging', async (t) => {
  const configDir = await withConfigDir(t)
  await upsertRemoteHost({ id: 'remote-fail', address: '192.0.2.110', user: 'dev', port: 22 })
  const capture = path.join(configDir, 'failed-payload.bin')
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  // 桩必须先把 stdin 读到 EOF 再按预设退出（SHIM_CAPTURE_FILE 就是那条 drain 路径）：
  // 否则「子进程已退、写端还在写」时本地先撞 EPIPE，断言会从「远端错误归一化」退化成
  // 「本地写失败」——单核挤压下 3/3 复现。真 ssh 也是一直消费 stdin 的，顺手断言字节
  // 确实到达传输层。本条只验错误归一化，写/退出的先后顺序不在范围内。
  setEnv(t, {
    SHIM_CAPTURE_FILE: capture,
    SHIM_SSH_STDERR: 'dev@192.0.2.110: Permission denied (publickey).',
    SHIM_SSH_EXIT: '255',
  })
  const payload = Buffer.from('payload')
  const source = Readable.from([payload])
  await assert.rejects(writeRemoteUpload('remote-fail', '/tmp/file.bin', source, 10240), /SSH authentication failed/)
  assert.deepEqual(await readFile(capture), payload)
})

test('writeRemoteUpload surfaces the remote failure when the write side breaks first', async (t) => {
  await withConfigDir(t)
  await upsertRemoteHost({ id: 'remote-mask', address: '192.0.2.110', user: 'dev', port: 22 })
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  // 故意不设 SHIM_CAPTURE_FILE：桩不读 stdin 就 exit 255，1MiB 一定写不完 → 写端必然先撞 EPIPE。
  // 这正是原来会抖的反向场景：用户必须看到远端原因，而不是本地 write EPIPE。
  setEnv(t, { SHIM_SSH_STDERR: 'dev@192.0.2.110: Permission denied (publickey).', SHIM_SSH_EXIT: '255' })
  const source = Readable.from([Buffer.alloc(1024 * 1024, 0x61)])
  const error = await writeRemoteUpload('remote-mask', '/tmp/file.bin', source, 10240).then(
    () => null,
    (failure: Error) => failure,
  )
  assert.ok(error, 'upload must fail')
  assert.equal(error.message, 'SSH authentication failed')
  assert.notEqual((error as NodeJS.ErrnoException).code, 'EPIPE')
})

test('writeRemoteUpload keeps AbortError instead of masking it with the remote fallback', async (t) => {
  const configDir = await withConfigDir(t)
  await upsertRemoteHost({ id: 'remote-abort', address: '192.0.2.110', user: 'dev', port: 22 })
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  // 桩把 stdin 读到 EOF 且保持存活：源流不产生数据也不结束，只有 abort 能收场
  setEnv(t, { SHIM_CAPTURE_FILE: path.join(configDir, 'abort.bin'), SHIM_SSH_EXIT: '0' })
  const controller = new AbortController()
  const stalled = new Readable({ read() {} })
  const promise = writeRemoteUpload('remote-abort', '/tmp/slow.bin', stalled, 10240, controller.signal)
  setTimeout(() => controller.abort(), 50)
  const error = await promise.then(
    () => null,
    (failure: Error) => failure,
  )
  assert.ok(error, 'aborted upload must reject')
  // 中止时 child 也会失败，但它只能给出 'Remote upload failed' 兜底文案；如实报 AbortError 才对
  assert.equal(error.name, 'AbortError', `abort was masked by: ${error.message}`)
})

// ---- 后台任务：状态迁移、冲突改名、失败清理 ----

test('runBackgroundUploadTask copies staged files into place and clears the staging area', async (t) => {
  const configDir = await withConfigDir(t)
  const roots = await getRoots()
  const root = roots[0]
  const targetDir = path.join(root.path, 'uploads', 'batch')
  t.after(async () => {
    await rm(path.join(root.path, 'uploads'), { recursive: true, force: true })
  })
  const staged = path.join(configDir, 'staged-one')
  await writeFile(staged, 'hello-upload')
  const { context, progress, logs, checkpoints } = makeContext()
  const result = await runBackgroundUploadTask(
    {
      hostId: 'local',
      targetRootId: root.id,
      targetPath: 'uploads/batch',
      conflictPolicy: 'rename',
      rateLimitKBps: 10240,
      files: [{ name: 'hello.txt', stagedPath: staged, size: 'hello-upload'.length }],
    },
    context,
  )
  assert.equal(result.message, 'Uploaded 1 file')
  const files = (result.result as { files: { name: string; path: string; absolutePath: string; size: number }[] }).files
  assert.deepEqual(files, [
    { name: 'hello.txt', path: 'uploads/batch/hello.txt', absolutePath: path.join(targetDir, 'hello.txt'), size: 12 },
  ])
  assert.equal(await readFile(path.join(targetDir, 'hello.txt'), 'utf8'), 'hello-upload')
  // 中转文件必须在成功后清掉，否则 upload-staging 会无限涨
  await assert.rejects(stat(staged), /ENOENT/)
  assert.deepEqual(logs, ['Uploaded hello.txt'])
  assert.equal(progress.at(-1)?.percent, 100)
  assert.ok(checkpoints() >= 2, 'resolution and completion must both checkpoint')
})

test('runBackgroundUploadTask renames conflicts, rejects unknown policies and aborts early', async (t) => {
  const configDir = await withConfigDir(t)
  const roots = await getRoots()
  const root = roots[0]
  const targetDir = path.join(root.path, 'uploads', 'conflict')
  await mkdir(targetDir, { recursive: true })
  await writeFile(path.join(targetDir, 'same.txt'), 'existing')
  t.after(async () => {
    await rm(path.join(root.path, 'uploads'), { recursive: true, force: true })
  })
  const staged = path.join(configDir, 'staged-conflict')
  await writeFile(staged, 'new-content')
  const input = {
    hostId: 'local',
    targetRootId: root.id,
    targetPath: 'uploads/conflict',
    conflictPolicy: 'rename',
    rateLimitKBps: 10240,
    files: [{ name: 'same.txt', stagedPath: staged, size: 'new-content'.length }],
  }
  // 冲突策略只支持 rename：其它值必须显式报错而不是静默覆盖用户文件
  await assert.rejects(
    runBackgroundUploadTask({ ...input, conflictPolicy: 'overwrite' }, makeContext().context),
    /Unsupported conflict policy/,
  )
  const { context } = makeContext()
  const result = await runBackgroundUploadTask(input, context)
  const name = (result.result as { files: { name: string }[] }).files[0].name
  assert.equal(name, 'same (1).txt')
  assert.equal(await readFile(path.join(targetDir, 'same.txt'), 'utf8'), 'existing')
  assert.equal(await readFile(path.join(targetDir, 'same (1).txt'), 'utf8'), 'new-content')

  // 已取消的任务在复制前就停手：不得产生半截目的文件
  await writeFile(staged, 'aborted')
  const controller = new AbortController()
  controller.abort()
  // 必须用新的 input：成功那轮已把 files[0].uploaded 写进原对象，复用它会被「已上传」跳过
  const abortInput = { ...input, files: [{ name: 'aborted.txt', stagedPath: staged, size: 'aborted'.length }] }
  await assert.rejects(runBackgroundUploadTask(abortInput, makeContext(controller.signal).context), /Task cancelled/)
  assert.equal(await readFile(path.join(targetDir, 'same (1).txt'), 'utf8'), 'new-content')
})

test('runBackgroundDownloadTask stores artifacts and refuses unsafe artifact ids', async (t) => {
  const configDir = await withConfigDir(t)
  const roots = await getRoots()
  const root = roots[0]
  const sourceDir = path.join(root.path, 'download-src')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(path.join(sourceDir, 'report.txt'), 'report-body')
  t.after(async () => {
    await rm(sourceDir, { recursive: true, force: true })
  })
  const artifactId = '77777777-7777-4777-8777-777777777777'
  const { context, progress } = makeContext()
  const result = await runBackgroundDownloadTask(
    { hostId: 'local', rootId: root.id, path: 'download-src/report.txt', rateLimitKBps: 10240, artifactId },
    context,
  )
  assert.equal(result.message, 'Prepared report.txt')
  const payload = result.result as { downloadUrl: string; fileName: string; size: number }
  assert.equal(payload.fileName, 'report.txt')
  assert.equal(payload.size, 'report-body'.length)
  assert.equal(payload.downloadUrl, `/api/hosts/local/files/download-tasks/${artifactId}`)
  assert.equal(await readFile(path.join(configDir, 'download-artifacts', artifactId), 'utf8'), 'report-body')
  assert.equal(progress.at(-1)?.percent, 100)
  // 目录下载：产物名带 .zip 后缀，进度按 null 上报（没有确定的字节总数）
  const dirArtifact = '88888888-8888-4888-8888-888888888888'
  const zip = await runBackgroundDownloadTask(
    { hostId: 'local', rootId: root.id, path: 'download-src', rateLimitKBps: 10240, artifactId: dirArtifact },
    context,
  )
  assert.equal((zip.result as { fileName: string }).fileName, 'download-src.zip')
  const archive = await readFile(path.join(configDir, 'download-artifacts', dirArtifact))
  assert.equal(archive.subarray(0, 2).toString('latin1'), 'PK')
  // artifactId 直接拼进路径：非 UUID 必须拒绝，避免 ../ 越界写
  await assert.rejects(
    runBackgroundDownloadTask(
      {
        hostId: 'local',
        rootId: root.id,
        path: 'download-src/report.txt',
        rateLimitKBps: 10240,
        artifactId: '../../escaped',
      },
      context,
    ),
    /Invalid download artifact/,
  )
})

test('runBackgroundDownloadTask resumes a retained partial artifact and resets on source change', async (t) => {
  const configDir = await withConfigDir(t)
  const roots = await getRoots()
  const root = roots[0]
  const sourceDir = path.join(root.path, 'download-resume')
  await mkdir(sourceDir, { recursive: true })
  const sourcePath = path.join(sourceDir, 'big.bin')
  const content = Buffer.alloc(2 * 1024 * 1024, 9)
  await writeFile(sourcePath, content)
  t.after(async () => {
    await rm(sourceDir, { recursive: true, force: true })
  })
  const artifactId = '99999999-9999-4999-8999-999999999999'
  const temporaryPath = path.join(configDir, 'download-artifacts', `${artifactId}.tmp`)
  await mkdir(path.dirname(temporaryPath), { recursive: true })
  // 已下载 512 KB 的半成品：续传必须从这里接上，且 checkpoint 在 1 MB 边界推进
  await writeFile(temporaryPath, content.subarray(0, 512 * 1024))
  const sourceInfo = await stat(sourcePath)
  const task = {
    hostId: 'local',
    rootId: root.id,
    path: 'download-resume/big.bin',
    rateLimitKBps: 10240,
    artifactId,
    downloadedBytes: 0,
    sourceSize: content.length,
    sourceModifiedAt: sourceInfo.mtime.toISOString(),
  }
  const { context, checkpoints } = makeContext()
  await runBackgroundDownloadTask(task, context)
  assert.equal(task.downloadedBytes, content.length)
  assert.deepEqual(await readFile(path.join(configDir, 'download-artifacts', artifactId)), content)
  assert.ok(checkpoints() >= 2, 'resume offset plus 1 MB boundary must checkpoint')

  // 源文件变了（大小不一致）→ 丢弃半成品从头下，不能拼出损坏文件
  const changedContent = Buffer.alloc(1024 * 1024, 3)
  await writeFile(sourcePath, changedContent)
  await writeFile(temporaryPath, Buffer.alloc(10, 1))
  const changedTask = { ...task, downloadedBytes: content.length }
  await runBackgroundDownloadTask(changedTask, makeContext().context)
  assert.deepEqual(await readFile(path.join(configDir, 'download-artifacts', artifactId)), changedContent)
  assert.equal(changedTask.downloadedBytes, changedContent.length)
})

test('runBackgroundDownloadTask fails clearly for a missing source', async () => {
  const roots = await getRoots()
  await assert.rejects(
    runBackgroundDownloadTask(
      {
        hostId: 'local',
        rootId: roots[0].id,
        path: 'does-not-exist.bin',
        rateLimitKBps: 10240,
        artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      makeContext().context,
    ),
    /ENOENT|no such file/i,
  )
})

test('resolveDefaultUploadTarget falls back to the workspace uploads dir for unusable panes', async () => {
  const roots = await getRoots()
  const fallbackRoot = roots.find((item) => item.label.toLowerCase() === 'workspace') || roots[0]
  const target = await resolveDefaultUploadTarget()
  assert.equal(target.source, 'fallback')
  assert.equal(target.rootId, fallbackRoot.id)
  assert.equal(target.path, 'uploads')
  assert.equal(target.absolutePath, path.join(fallbackRoot.path, 'uploads'))
  // 无效 pane 目标不能让上传失败：解析异常必须吞掉并回落
  const withPane = await resolveDefaultUploadTarget('%9999999')
  assert.equal(withPane.source, 'fallback')
})
