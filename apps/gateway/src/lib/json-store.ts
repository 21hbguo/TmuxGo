import { randomUUID } from 'crypto'
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import path from 'path'

// 最小 JSON 持久化：原子 temp+rename、0600、进程内写队列串行化 +
// 同路径 .lock 文件跨进程互斥 read-modify-write、主文件损坏时回落 .bak。
// payload 保持 {version:1, updatedAt, <key>: items} 旧格式——旧文件原样可读。

export class JsonStoreCorruptionError extends Error {
  code = 'JSON_STORE_CORRUPT'
  constructor(filePath: string) {
    super(`Persisted data is corrupted and no usable backup exists: ${path.basename(filePath)}`)
  }
}

export class JsonStoreLockError extends Error {
  code = 'JSON_STORE_LOCK_TIMEOUT'
  constructor(filePath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for store lock: ${path.basename(filePath)}`)
  }
}

export interface JsonStoreOptions<T> {
  // payload 顶层条目字段名（templates / workspaces …），同时用于判定结构是否合法：
  // JSON 能解析但该字段不是数组 → 视为损坏，走 backup/报错，绝不静默当空数据覆盖
  key: string
  normalize: (input: unknown) => T[]
  // 设置时校验 payload.version：不匹配的版本视为不可读（损坏语义），
  // 防止旧代码误读新模式文件；未设置则不看 version（保持无版本约束的旧行为）
  expectedVersion?: number
  // 跨进程锁等待上限（超时抛 JsonStoreLockError）；默认 10s，仅测试需要注入缩短
  lockTimeoutMs?: number
  // 锁文件 mtime 超过此值视为持有者崩溃遗留（stale），默认 15s
  lockStaleMs?: number
}

interface LockMeta {
  pid: number
  token: string
}

function parseLockMeta(raw: string): LockMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockMeta>
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return { pid: parsed.pid, token: parsed.token }
    }
  } catch {
    // 锁文件写一半进程死亡：内容不可解析，退化为只靠 mtime 判 stale
  }
  return null
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但属他人；ESRCH = 已退出
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve()
  private tempSeq = 0
  // filePath 支持 getter：TMUXGO_CONFIG_DIR 等 env 可能在模块加载后才确定，
  // 旧代码按请求取路径，这里在每次入队操作时求值以保持同等行为
  constructor(
    private pathSource: string | (() => string),
    private options: JsonStoreOptions<T>,
  ) {}

  private get filePath() {
    return typeof this.pathSource === 'function' ? this.pathSource() : this.pathSource
  }

  private get backupPath() {
    return `${this.filePath}.bak`
  }

  private get lockPath() {
    return `${this.filePath}.lock`
  }

  // null = 文件不存在；结构非法/不可解析/不可读 → CorruptionError（交给上层回落）
  private async loadFile(filePath: string): Promise<T[] | null> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new JsonStoreCorruptionError(filePath)
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (
      this.options.expectedVersion !== undefined &&
      (parsed === null || typeof parsed !== 'object' || parsed.version !== this.options.expectedVersion)
    )
      throw new JsonStoreCorruptionError(filePath)
    const items = parsed?.[this.options.key]
    if (!Array.isArray(items)) throw new JsonStoreCorruptionError(filePath)
    return this.options.normalize(items)
  }

  async read(): Promise<T[]> {
    let mainCorrupt = false
    try {
      const main = await this.loadFile(this.filePath)
      if (main !== null) return main
    } catch {
      // 主文件损坏：按序回落 backup
      mainCorrupt = true
    }
    const backup = await this.loadFile(this.backupPath).catch(() => null)
    if (backup !== null) return backup
    // 主文件存在但不可解析、backup 也救不回：报错而不是返回空数据覆盖
    if (mainCorrupt) throw new JsonStoreCorruptionError(this.filePath)
    return []
  }

  private async persist(items: T[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    // 先备份当前主文件再替换：写失败/新文件损坏时 .bak 始终持有上一份可读版本
    await copyFile(this.filePath, this.backupPath).catch(() => {})
    const temp = `${this.filePath}.tmp-${process.pid}-${this.tempSeq++}`
    const payload = {
      version: this.options.expectedVersion ?? 1,
      updatedAt: new Date().toISOString(),
      [this.options.key]: items,
    }
    try {
      await writeFile(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.filePath)
      await chmod(this.filePath, 0o600).catch(() => {})
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  // 跨进程互斥：同一 store 路径用 <file>.lock 的 O_CREAT|O_EXCL 原子创建做锁，
  // 内容 {pid, token}。不同路径各有独立锁文件，互不阻塞。
  // 等待方轮询至超时抛 JsonStoreLockError，绝不无限等待；锁 mtime 老化
  // （默认 15s）或记录持有 pid 已退出 → stale，删除后重抢。释放前核对
  // token，防止自身锁被判定 stale 抢走后误删新持有者的锁。
  private static readonly lockPollMs = 40

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = this.lockPath
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    const token = `${process.pid}:${randomUUID()}`
    const meta = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })
    const timeoutMs = this.options.lockTimeoutMs ?? 10_000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let created = false
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        created = true
        try {
          await handle.writeFile(meta)
        } finally {
          await handle.close()
        }
        return () => this.releaseLock(lockPath, token)
      } catch (error) {
        // writeFile/close 失败但 wx 已把锁文件建出来：清掉自己的残锁再抛，
        // 否则留下空锁要等 15s stale 才能被回收
        if (created) await rm(lockPath, { force: true }).catch(() => {})
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (await this.lockIsStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {})
      } else if (Date.now() >= deadline) {
        throw new JsonStoreLockError(this.filePath, timeoutMs)
      } else {
        const poll = JsonStore.lockPollMs
        await new Promise((resolve) => setTimeout(resolve, poll + Math.random() * poll))
      }
    }
  }

  private async lockIsStale(lockPath: string): Promise<boolean> {
    const info = await stat(lockPath).catch(() => null)
    if (!info) return true // 刚好被释放：下一轮 wx 直接重建
    if (Date.now() - info.mtimeMs > (this.options.lockStaleMs ?? 15_000)) return true
    const meta = await readFile(lockPath, 'utf8')
      .then(parseLockMeta)
      .catch(() => null)
    // 持有进程已死：安全回收（同主机 pid 判定；pid 复用时 token 释放兜底不误删）
    return meta !== null && !pidAlive(meta.pid)
  }

  private async releaseLock(lockPath: string, token: string) {
    const meta = await readFile(lockPath, 'utf8')
      .then(parseLockMeta)
      .catch(() => null)
    // 锁已消失/已易主：绝不能删，否则会删掉新持有者刚建的锁
    if (meta?.token !== token) return
    await rm(lockPath, { force: true }).catch(() => {})
  }

  private async withLock<R>(job: () => Promise<R>): Promise<R> {
    const release = await this.acquireLock()
    try {
      return await job()
    } finally {
      await release()
    }
  }

  private enqueue<R>(job: () => Promise<R>): Promise<R> {
    const next = this.queue.then(job, job)
    // 队列本身不吸收失败：失败传播给调用方，后续写入仍按序继续
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async write(items: T[]): Promise<void> {
    return this.enqueue(() => this.withLock(() => this.persist(items)))
  }

  // 串行区内持锁 re-read：进程内队列 + 跨进程锁双重互斥；mutate 抛错即
  // 放弃写入并传播错误，finally 保证锁一定归还
  async update<R>(mutate: (items: T[]) => { items: T[]; result: R }): Promise<R> {
    return this.enqueue(() =>
      this.withLock(async () => {
        const current = await this.read()
        const { items, result } = mutate(current)
        await this.persist(items)
        return result
      }),
    )
  }
}
