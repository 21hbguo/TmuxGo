import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { JsonStore } from './json-store.js'

export interface GitWorktreeInfo {
  path: string
  head: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}
export interface GitWorktreeRecord {
  id: string
  hostId: string
  repoPath: string
  worktreePath: string
  branch?: string
  commit?: string
  workspaceId?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
}

const MAX_WORKTREE_RECORDS = 200
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

function getWorktreeStorePath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'git-worktrees.json')
}

export function parseWorktreeListPorcelain(stdout: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  let current: GitWorktreeInfo | null = null
  for (const line of stdout.split('\n')) {
    if (!line) {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: line.slice(9), head: '', detached: false, bare: false, locked: false, prunable: false }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (current && line === 'detached') {
      current.detached = true
    } else if (current && line === 'bare') {
      current.bare = true
    } else if (current && line.startsWith('locked')) {
      current.locked = true
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

// 目标路径必须稳定且绝对：拒绝 .. 段/NUL/非绝对，防止参数语义漂移；
// args 数组 + `--` 分隔保证它永远只是位置参数，不会被解释成选项
export function assertSafeWorktreePath(value: string) {
  const p = (value || '').trim()
  if (!p.startsWith('/')) throw new Error('Worktree path must be absolute')
  if (p.includes('\0')) throw new Error('Invalid worktree path')
  if (p.split('/').includes('..')) throw new Error('Worktree path must not contain ".."')
  const normalized = path.posix.normalize(p).replace(/\/+$/, '') || '/'
  if (!normalized.startsWith('/')) throw new Error('Invalid worktree path')
  return normalized
}

// 分支名仅允许安全字符集且不得以 - 开头（防被解析为 option）；
// git 端 check-ref-format 规则更严，不合法的名字在远端也只是普通失败
export function assertSafeBranchName(value: string, field = 'branch') {
  const name = (value || '').trim()
  if (!name) throw new Error(`Missing ${field}`)
  if (!REF_NAME_PATTERN.test(name)) throw new Error(`Invalid ${field}`)
  if (name.includes('..') || name.includes('@{') || name.endsWith('.lock') || name.endsWith('/')) {
    throw new Error(`Invalid ${field}`)
  }
  return name
}

export interface WorktreeAddOptions {
  worktreePath: string
  newBranch?: string
  branch?: string
  commit?: string
}
export function buildWorktreeAddArgs(options: WorktreeAddOptions) {
  const args = ['worktree', 'add']
  if (options.newBranch) args.push('-b', assertSafeBranchName(options.newBranch, 'newBranch'))
  else if (!options.branch) args.push('--detach') // 无分支时必须显式 detach，否则 git 会按目录名自动建分支
  args.push('--', options.worktreePath)
  const start = options.branch ? assertSafeBranchName(options.branch) : options.commit
  if (start) args.push(start)
  return args
}

export function buildWorktreeRemoveArgs(worktreePath: string, force: boolean) {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push('--', worktreePath)
  return args
}

export type WorktreeRemoveFailure = 'dirty' | 'missing' | 'other'
export function classifyWorktreeRemoveError(message: string): WorktreeRemoveFailure {
  const text = message.toLowerCase()
  if (text.includes('modified or untracked') || text.includes('is dirty')) return 'dirty'
  if (text.includes('is not a working tree') || text.includes('no such file or directory')) return 'missing'
  return 'other'
}
// git 报错文案随宿主 locale 变化（如 zh_CN 下 dirty 提示不含英文关键词），
// 文案启发式失效时按实况复检：不在 worktree list → missing；仍有改动 → dirty
export async function classifyWorktreeRemoveByState(
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>,
  repoPath: string,
  worktreePath: string,
): Promise<WorktreeRemoveFailure> {
  try {
    const { stdout } = await exec(['worktree', 'list', '--porcelain'], repoPath)
    if (!parseWorktreeListPorcelain(stdout).some((item) => item.path === worktreePath)) return 'missing'
    const { stdout: status } = await exec(['status', '--porcelain=v2', '--untracked-files=all'], worktreePath)
    if (status.trim()) return 'dirty'
  } catch {
    // 路径已损坏/非仓库等情况都按 other 交由原始错误表达
  }
  return 'other'
}

function normalizeRecord(input: unknown): GitWorktreeRecord | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const str = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const hostId = str(raw.hostId, 120)
  const repoPath = str(raw.repoPath)
  const worktreePath = str(raw.worktreePath)
  if (!hostId || !repoPath || !worktreePath) return null
  const now = new Date().toISOString()
  return {
    id: str(raw.id, 64) || randomUUID(),
    hostId,
    repoPath,
    worktreePath,
    branch: str(raw.branch, 200),
    commit: str(raw.commit, 128),
    workspaceId: str(raw.workspaceId, 64),
    sessionId: str(raw.sessionId, 256),
    createdAt: str(raw.createdAt, 64) || now,
    updatedAt: str(raw.updatedAt, 64) || now,
  }
}
// 持久化走 JsonStore（0600/原子写/.bak/串行 update）；按解析后路径缓存
// store——config dir 变更时仍各自成队，队列按文件共享才有互斥语义
const worktreeStores = new Map<string, JsonStore<GitWorktreeRecord>>()
function getWorktreeStore() {
  const file = getWorktreeStorePath()
  let store = worktreeStores.get(file)
  if (!store) {
    store = new JsonStore<GitWorktreeRecord>(file, {
      key: 'worktrees',
      normalize: (input) =>
        (Array.isArray(input) ? input : [])
          .map(normalizeRecord)
          .filter(Boolean)
          .slice(0, MAX_WORKTREE_RECORDS) as GitWorktreeRecord[],
    })
    worktreeStores.set(file, store)
  }
  return store
}
export function readWorktreeRecords(): Promise<GitWorktreeRecord[]> {
  return getWorktreeStore().read()
}
export function worktreeRecordKey(hostId: string, repoPath: string, worktreePath: string) {
  return `${hostId}|${repoPath}|${worktreePath}`
}
export async function upsertWorktreeRecord(
  entry: Omit<GitWorktreeRecord, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<GitWorktreeRecord> {
  return getWorktreeStore().update((records) => {
    const now = new Date().toISOString()
    const key = worktreeRecordKey(entry.hostId, entry.repoPath, entry.worktreePath)
    const existing = records.find((item) => worktreeRecordKey(item.hostId, item.repoPath, item.worktreePath) === key)
    const record: GitWorktreeRecord = {
      ...existing,
      ...entry,
      id: existing?.id || randomUUID(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    const items = (
      existing ? records.map((item) => (item.id === existing.id ? record : item)) : [record, ...records]
    ).slice(0, MAX_WORKTREE_RECORDS)
    return { items, result: record }
  })
}
export async function removeWorktreeRecord(hostId: string, repoPath: string, worktreePath: string) {
  const key = worktreeRecordKey(hostId, repoPath, worktreePath)
  await getWorktreeStore().update((records) => {
    const items = records.filter((item) => worktreeRecordKey(item.hostId, item.repoPath, item.worktreePath) !== key)
    return { items, result: items.length !== records.length }
  })
}
export async function mergeWorktreeProvenance(hostId: string, repoPath: string, worktrees: GitWorktreeInfo[]) {
  const records = await readWorktreeRecords()
  const byPath = new Map(
    records
      .filter((item) => item.hostId === hostId && item.repoPath === repoPath)
      .map((item) => [item.worktreePath, item]),
  )
  return worktrees.map((item) => ({ ...item, provenance: byPath.get(item.path) }))
}
