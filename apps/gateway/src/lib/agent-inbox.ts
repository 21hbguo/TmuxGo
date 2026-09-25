import { createHash, randomUUID } from 'crypto'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { createReadStream, rmSync } from 'fs'
import os from 'os'
import path from 'path'

// pane 内 agent → TmuxGo UI 的推送收件箱。metadata 存 JSON（原子 rename 落盘，
// 同 agent-notifications 约定），二进制按 sha256 分层存 inbox-assets/。
// WS 只广播 metadata 事件，内容一律走 REST 拉取——大文件不进 ws/JSON。

export type InboxMessageType = 'text' | 'image' | 'video' | 'file' | 'link'
export interface InboxMessageRoute {
  hostId?: string
  sessionName?: string
  paneId?: string
  tmuxPaneId?: string
}
export interface InboxMessageSource {
  provider?: string
  agent?: string
  agentSessionId?: string
}
export interface AgentInboxMessage {
  id: string
  type: InboxMessageType
  title?: string
  text?: string
  assetId?: string
  mime?: string
  size?: number
  sha256?: string
  name?: string
  source: InboxMessageSource
  route: InboxMessageRoute
  createdAt: string
  readBy: string[]
  expiresAt?: string
  dedupeKey?: string
  open?: boolean
  metadata?: Record<string, unknown>
}
export interface InboxAsset {
  id: string
  sha256: string
  mime: string
  size: number
  name: string
  path: string
  createdAt: string
}

export type InboxEvent =
  | { type: 'inbox_message_created'; message: AgentInboxMessage }
  | { type: 'inbox_message_updated'; message: AgentInboxMessage }
  | { type: 'inbox_message_deleted'; ids: string[] }
  | { type: 'inbox_open_target'; route: InboxMessageRoute; messageId?: string }

const STORE_VERSION = 1
const MAX_MESSAGES = 1000
const MAX_TEXT_BYTES = 256 * 1024
const MAX_BASE64_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MESSAGE_TTL_MS = 30 * 24 * 3600 * 1000
const TITLE_MAX = 160
const NAME_MAX = 256

interface InboxStore {
  version: 1
  messages: AgentInboxMessage[]
  assets: InboxAsset[]
  dedupe: Record<string, string>
}

let store: InboxStore | null = null
let storePromise: Promise<InboxStore> | null = null
let loadedStorePath: string | null = null
let savePromise: Promise<void> = Promise.resolve()
let saveSequence = 0
const listeners = new Set<(event: InboxEvent) => void>()

function configDir() {
  return process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
}
function storePath() {
  return path.join(configDir(), 'agent-inbox.json')
}
function assetsRoot() {
  return process.env.TMUXGO_DATA_DIR?.trim() || path.join(configDir(), 'inbox-assets')
}
function assetDirFor(sha256: string) {
  return path.join(assetsRoot(), sha256.slice(0, 2))
}
function assetPathFor(sha256: string) {
  return path.join(assetDirFor(sha256), sha256)
}

async function writeStore(value: InboxStore, targetPath: string) {
  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${targetPath}.${process.pid}.${++saveSequence}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temporary, targetPath)
  await chmod(targetPath, 0o600)
}
async function backupCorruptStore() {
  await copyFile(storePath(), `${storePath()}.corrupt-${Date.now()}`).catch(() => {})
}
async function saveStore(value: InboxStore) {
  const targetPath = storePath()
  const pending = savePromise.then(
    () => writeStore(value, targetPath),
    () => writeStore(value, targetPath),
  )
  savePromise = pending.then(
    () => undefined,
    () => undefined,
  )
  await pending
}
function normalizeMessage(value: unknown): AgentInboxMessage | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<AgentInboxMessage>
  if (typeof item.id !== 'string' || !item.id) return null
  if (!['text', 'image', 'video', 'file', 'link'].includes(String(item.type))) return null
  if (typeof item.createdAt !== 'string' || !item.createdAt) return null
  if (!item.source || typeof item.source !== 'object') return null
  if (!item.route || typeof item.route !== 'object') return null
  return {
    ...item,
    readBy: Array.isArray(item.readBy) ? item.readBy.filter((v): v is string => typeof v === 'string') : [],
  } as AgentInboxMessage
}
async function loadStore() {
  const currentPath = storePath()
  if (store && loadedStorePath === currentPath) return store
  if (loadedStorePath !== currentPath) store = null
  if (storePromise) return storePromise
  storePromise = (async () => {
    let loaded: InboxStore | null = null
    try {
      const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<InboxStore>
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.messages) && Array.isArray(parsed.assets))
        loaded = {
          version: STORE_VERSION,
          messages: parsed.messages.map(normalizeMessage).filter((v): v is AgentInboxMessage => !!v),
          assets: parsed.assets as InboxAsset[],
          dedupe: parsed.dedupe && typeof parsed.dedupe === 'object' ? parsed.dedupe : {},
        }
      else await backupCorruptStore()
    } catch (err: any) {
      // JSON 损坏：留 .corrupt 副本供人工恢复再重建，别静默覆盖索引
      if (err?.code !== 'ENOENT') await backupCorruptStore()
    }
    store = loaded || { version: STORE_VERSION, messages: [], assets: [], dedupe: {} }
    loadedStorePath = currentPath
    await sweepExpired(store)
    await saveStore(store)
    return store
  })().finally(() => {
    storePromise = null
  })
  return storePromise
}

// 过期/超限清理：message TTL + 总数上限 + asset 孤儿回收与总量配额
async function sweepExpired(value: InboxStore) {
  const now = Date.now()
  value.messages = value.messages.filter((m) => {
    if (m.expiresAt && Date.parse(m.expiresAt) < now) return false
    return now - Date.parse(m.createdAt) < MESSAGE_TTL_MS
  })
  if (value.messages.length > MAX_MESSAGES) {
    // FIFO：保留最新 MAX_MESSAGES 条
    value.messages = value.messages.slice(value.messages.length - MAX_MESSAGES)
  }
  const liveAssetIds = new Set(value.messages.map((m) => m.assetId).filter(Boolean) as string[])
  const liveSha = new Set<string>()
  value.assets = value.assets.filter((asset) => liveAssetIds.has(asset.id))
  let total = 0
  for (const asset of value.assets) total += asset.size || 0
  // 超配额按 createdAt 淘汰 asset（仅未被引用时不存在——被引用的淘汰旧消息释放）
  if (total > MAX_ASSET_BYTES) {
    const sorted = [...value.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const message of sorted) {
      if (total <= MAX_ASSET_BYTES) break
      const asset = message.assetId ? value.assets.find((v) => v.id === message.assetId) : null
      if (asset) {
        value.messages = value.messages.filter((v) => v.id !== message.id)
        // 同 sha 资产可能被多条消息共享——还有引用时只删消息，别留下悬空 assetId
        const stillReferenced = value.messages.some((v) => v.assetId === asset.id)
        if (!stillReferenced) {
          total -= asset.size || 0
          value.assets = value.assets.filter((v) => v.id !== asset.id)
        }
      }
    }
  }
  for (const asset of value.assets) liveSha.add(asset.sha256)
  // dedupe 只进不出会随时间无界增长：清掉已不在消息集里的映射
  const liveIds = new Set(value.messages.map((m) => m.id))
  for (const key of Object.keys(value.dedupe)) {
    if (!liveIds.has(value.dedupe[key])) delete value.dedupe[key]
  }
  // 孤儿 asset 文件回收（异步失败不影响主流程）
  void (async () => {
    try {
      const root = assetsRoot()
      // 只收 sha256 布局产物：2-hex 目录 + 64-hex 文件名。assetsRoot 指向
      // 用户自选目录（TMUXGO_DATA_DIR）时绝不能误删其他文件
      for (const dir of await readdir(root).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue
        const dirPath = path.join(root, dir)
        for (const file of await readdir(dirPath).catch(() => [] as string[])) {
          if (/^[0-9a-f]{64}$/.test(file) && !liveSha.has(file))
            await rm(path.join(dirPath, file), { force: true }).catch(() => {})
        }
      }
    } catch {}
  })()
}

export function subscribeInbox(listener: (event: InboxEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function emitInbox(event: InboxEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {}
  }
}

const SAFE_NAME = /[^\w.()\- +#[\]]+/g
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.azure(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker(\/|$)/,
  /(^|\/)\.env([./]|$)/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/,
  /(^|\/)\.tmuxgo\/(agent-inbox\.json|agent-event-token)$/,
  /(^|\/)\.claude(\.json|\/|$)/,
  /(^|\/)\.codex\/(auth|config)/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)config\.gcloud(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)\.hermes\//,
  /(^|\/)proc\/[^/]+\/environ$/,
  /\.(pem|key|p12|pfx)$/i,
]
export function isSensitivePath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
}
export function sanitizeFileName(name: string) {
  // basename 语义：路径分隔符一律截到最后一段，再剥危险字符与隐藏点前缀
  const base = name.split(/[\\/]/).filter(Boolean).pop() || 'file'
  const cleaned = base.replace(SAFE_NAME, '_').replace(/^\.+/, '').slice(0, NAME_MAX)
  return cleaned || 'file'
}
export function normalizeRoute(value: unknown): InboxMessageRoute {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const route: InboxMessageRoute = {}
  if (typeof raw.hostId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw.hostId)) route.hostId = raw.hostId
  if (typeof raw.sessionName === 'string' && raw.sessionName.length <= 64) route.sessionName = raw.sessionName
  if (typeof raw.tmuxPaneId === 'string' && /^%[0-9]+$/.test(raw.tmuxPaneId)) route.tmuxPaneId = raw.tmuxPaneId
  if (typeof raw.paneId === 'string' && raw.paneId.length <= 256) route.paneId = raw.paneId
  return route
}
function normalizeSource(value: unknown): InboxMessageSource {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const source: InboxMessageSource = {}
  if (typeof raw.provider === 'string') source.provider = raw.provider.slice(0, 64)
  if (typeof raw.agent === 'string') source.agent = raw.agent.slice(0, 64)
  if (typeof raw.agentSessionId === 'string') source.agentSessionId = raw.agentSessionId.slice(0, 128)
  return source
}

export interface PushInput {
  type: InboxMessageType
  title?: unknown
  text?: unknown
  name?: unknown
  mime?: unknown
  linkUrl?: unknown
  route?: unknown
  source?: unknown
  open?: unknown
  dedupeKey?: unknown
  expiresInMs?: unknown
  metadata?: unknown
  // 三选一的内容载体：本地路径引用 / base64 / 已上传 buffer（multipart）
  path?: unknown
  base64?: unknown
  buffer?: Buffer
  declaredSha256?: unknown
}

function guessMime(fileName: string, declared?: string) {
  if (declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) && declared.length <= 128) return declared
  const ext = path.extname(fileName).toLowerCase()
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.log': 'text/plain',
  }
  return table[ext] || 'application/octet-stream'
}
function typeFromMime(mime: string, fallback: InboxMessageType) {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return fallback === 'image' || fallback === 'video' ? fallback : 'file'
}

export async function createPush(input: PushInput) {
  const value = await loadStore()
  const dedupeKey =
    typeof input.dedupeKey === 'string' && input.dedupeKey.trim() ? input.dedupeKey.trim().slice(0, 128) : undefined
  if (dedupeKey && value.dedupe[dedupeKey]) {
    const existing = value.messages.find((m) => m.id === value.dedupe[dedupeKey])
    if (existing) return { message: existing, deduplicated: true }
  }
  const type: InboxMessageType = ['text', 'image', 'video', 'file', 'link'].includes(String(input.type))
    ? input.type
    : 'text'
  const title =
    typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, TITLE_MAX) : undefined
  const route = normalizeRoute(input.route)
  const source = normalizeSource(input.source)
  const open = input.open === true

  const message: AgentInboxMessage = {
    id: randomUUID(),
    type,
    title,
    source,
    route,
    createdAt: new Date().toISOString(),
    readBy: [],
    dedupeKey,
    open,
  }
  if (typeof input.metadata === 'object' && input.metadata) {
    try {
      message.metadata = JSON.parse(JSON.stringify(input.metadata).slice(0, 8192))
    } catch {}
  }
  if (typeof input.expiresInMs === 'number' && input.expiresInMs > 0)
    message.expiresAt = new Date(Date.now() + Math.min(input.expiresInMs, MESSAGE_TTL_MS)).toISOString()

  if (type === 'text' || type === 'link') {
    const text = typeof input.text === 'string' ? input.text : typeof input.linkUrl === 'string' ? input.linkUrl : ''
    if (!text.trim()) throw new Error('Push requires text or linkUrl')
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Text exceeds 256KiB limit')
    message.text = text
    if (type === 'link' && !/^https?:\/\//i.test(text)) throw new Error('link type requires http(s) URL')
  } else {
    // 二进制：path 引用 / base64 / multipart buffer 三选一
    let content: Buffer
    let name = typeof input.name === 'string' && input.name.trim() ? sanitizeFileName(input.name.trim()) : 'file'
    if (Buffer.isBuffer(input.buffer)) {
      content = input.buffer
    } else if (typeof input.path === 'string' && input.path.trim()) {
      const resolved = path.resolve(input.path.trim().replace(/^~(?=\/|$)/, os.homedir()))
      // realpath 解符号链接再查 denylist——`ln -s ~/.ssh/id_rsa x.png`
      // 这类链接名检查会漏判目标
      const real = await realpath(resolved).catch(() => resolved)
      if (isSensitivePath(resolved) || isSensitivePath(real)) throw new Error('Refusing to read sensitive path')
      const info = await stat(real)
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > MAX_ASSET_BYTES) throw new Error('File exceeds asset size limit')
      content = await readFile(real)
      if (name === 'file') name = sanitizeFileName(path.basename(real))
    } else if (typeof input.base64 === 'string' && input.base64) {
      content = Buffer.from(input.base64, 'base64')
      if (content.length > MAX_BASE64_BYTES) throw new Error('base64 payload exceeds 32MiB limit')
    } else {
      throw new Error('Push requires path, base64, or multipart file')
    }
    if (content.length === 0) throw new Error('Empty content')
    if (content.length > MAX_ASSET_BYTES) throw new Error('Content exceeds asset size limit')
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (typeof input.declaredSha256 === 'string' && input.declaredSha256 && input.declaredSha256 !== sha256)
      throw new Error('sha256 mismatch')
    const mime = guessMime(name, typeof input.mime === 'string' ? input.mime : undefined)
    const assetPath = assetPathFor(sha256)
    const already = value.assets.find((a) => a.sha256 === sha256)
    let asset: InboxAsset
    if (already) {
      asset = already
    } else {
      await mkdir(assetDirFor(sha256), { recursive: true, mode: 0o700 })
      // 同 sha256 已存在的文件直接复用（内容寻址天然幂等）
      if (!(await stat(assetPath).catch(() => null))) {
        const tmp = `${assetPath}.${process.pid}.${++saveSequence}.tmp`
        await writeFile(tmp, content, { mode: 0o600 })
        await rename(tmp, assetPath)
      }
      asset = {
        id: randomUUID(),
        sha256,
        mime,
        size: content.length,
        name,
        path: path.relative(assetsRoot(), assetPath),
        createdAt: new Date().toISOString(),
      }
      value.assets.push(asset)
    }
    message.type = typeFromMime(mime, type)
    message.assetId = asset.id
    message.mime = mime
    message.size = content.length
    message.sha256 = sha256
    message.name = name
  }

  value.messages.push(message)
  if (dedupeKey) value.dedupe[dedupeKey] = message.id
  await sweepExpired(value)
  await saveStore(value)
  emitInbox({ type: 'inbox_message_created', message })
  if (open) emitInbox({ type: 'inbox_open_target', route, messageId: message.id })
  return { message, deduplicated: false }
}

export async function listInboxMessages(
  options: { cursor?: string; limit?: number; unreadForDevice?: string; sessionName?: string; paneId?: string } = {},
) {
  const value = await loadStore()
  let items = [...value.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (options.sessionName) items = items.filter((m) => m.route.sessionName === options.sessionName)
  if (options.paneId)
    items = items.filter((m) => m.route.paneId === options.paneId || m.route.tmuxPaneId === options.paneId)
  if (options.unreadForDevice) items = items.filter((m) => !m.readBy.includes(options.unreadForDevice!))
  // cursor = 上一页最后一条的 createdAt+id，翻更旧的消息
  if (options.cursor) {
    const index = items.findIndex((m) => `${m.createdAt}#${m.id}` === options.cursor)
    if (index >= 0) items = items.slice(0, index)
  }
  const limit = Math.min(Math.max(options.limit || 50, 1), 200)
  const page = items.slice(Math.max(0, items.length - limit))
  const nextCursor =
    items.length > page.length
      ? `${items[items.length - page.length - 1].createdAt}#${items[items.length - page.length - 1].id}`
      : null
  const unreadCount = options.unreadForDevice
    ? value.messages.filter((m) => !m.readBy.includes(options.unreadForDevice!)).length
    : undefined
  return { messages: page, nextCursor, unreadCount, total: items.length }
}

export async function getInboxMessage(id: string) {
  const value = await loadStore()
  return value.messages.find((m) => m.id === id) || null
}
export async function getInboxAsset(assetId: string) {
  const value = await loadStore()
  return value.assets.find((a) => a.id === assetId) || null
}
// asset.path 相对 assetsRoot 存储；解析后必须落在 assetsRoot 内，防 store
// 被篡改后越界读盘。旧记录锚在 configDir（带 inbox-assets/ 前缀）——剥掉兼容
export function resolveAssetPath(asset: InboxAsset) {
  const rel = asset.path.replace(/^inbox-assets[\\/]/, '')
  const resolved = path.resolve(assetsRoot(), rel)
  if (!resolved.startsWith(path.resolve(assetsRoot()) + path.sep)) throw new Error('Invalid asset path')
  return resolved
}
export async function getAssetStream(asset: InboxAsset, range?: { start: number; end: number }) {
  return createReadStream(resolveAssetPath(asset), range)
}
const MAX_READ_BY = 64
export async function markInboxRead(ids: string[], deviceId: string) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const changed: AgentInboxMessage[] = []
  for (const message of value.messages) {
    if (!idSet.has(message.id) || message.readBy.includes(deviceId)) continue
    // readBy 无界增长会被灌水——超上限丢最老设备标记
    if (message.readBy.length >= MAX_READ_BY) message.readBy.shift()
    message.readBy.push(deviceId)
    changed.push(message)
  }
  // 先落盘再广播：崩溃窗口内前端状态不得领先盘上状态
  if (changed.length) {
    await saveStore(value)
    for (const message of changed) emitInbox({ type: 'inbox_message_updated', message })
  }
  return { changed: changed.length }
}
export async function deleteInboxMessages(ids: string[]) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const removed = value.messages.filter((m) => idSet.has(m.id))
  value.messages = value.messages.filter((m) => !idSet.has(m.id))
  for (const key of Object.keys(value.dedupe)) {
    if (idSet.has(value.dedupe[key])) delete value.dedupe[key]
  }
  await sweepExpired(value)
  if (removed.length) {
    await saveStore(value)
    emitInbox({ type: 'inbox_message_deleted', ids: removed.map((m) => m.id) })
  }
  return { removed: removed.length }
}
export async function requestOpenTarget(route: InboxMessageRoute, messageId?: string) {
  emitInbox({ type: 'inbox_open_target', route, messageId })
  return { ok: true }
}

// 测试挂钩：重置内存态并让 loadStore 落到干净 store（test-env 的 config dir
// 在进程内共享，不同步清文件会读到上个用例的持久化消息）
export function _resetInboxForTest(options: { keepStore?: boolean } = {}) {
  store = null
  storePromise = null
  loadedStorePath = null
  listeners.clear()
  if (!options.keepStore) {
    try {
      rmSync(storePath(), { force: true })
    } catch {}
  }
}
export { assetsRoot as _assetsRootForTest }
