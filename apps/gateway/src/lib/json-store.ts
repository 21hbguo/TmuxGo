import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import path from 'path'

// 最小 JSON 持久化：原子 temp+rename、0600、进程内写队列串行化 read-modify-write、
// 主文件损坏时回落 .bak。仅面向单进程部署（约定见派工单），不做跨进程锁。
// payload 保持 {version:1, updatedAt, <key>: items} 旧格式——旧文件原样可读。

export class JsonStoreCorruptionError extends Error {
  code = 'JSON_STORE_CORRUPT'
  constructor(filePath: string) {
    super(`Persisted data is corrupted and no usable backup exists: ${path.basename(filePath)}`)
  }
}

export interface JsonStoreOptions<T> {
  // payload 顶层条目字段名（templates / workspaces …），同时用于判定结构是否合法：
  // JSON 能解析但该字段不是数组 → 视为损坏，走 backup/报错，绝不静默当空数据覆盖
  key: string
  normalize: (input: unknown) => T[]
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
    const payload = { version: 1, updatedAt: new Date().toISOString(), [this.options.key]: items }
    try {
      await writeFile(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.filePath)
      await chmod(this.filePath, 0o600).catch(() => {})
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
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
    return this.enqueue(() => this.persist(items))
  }

  // 串行区内 re-read：并发写天然互斥；mutate 抛错即放弃写入并传播错误
  async update<R>(mutate: (items: T[]) => { items: T[]; result: R }): Promise<R> {
    return this.enqueue(async () => {
      const current = await this.read()
      const { items, result } = mutate(current)
      await this.persist(items)
      return result
    })
  }
}
