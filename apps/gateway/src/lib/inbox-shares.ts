import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { getAuthGeneration } from './auth.js'

// 收件箱附件的「显式外链」存储：与 share-links 同一模型——随机 id + token 只存
// sha256、限时有效、可撤销、跟随 auth generation 失效。对外路由 /s/i/:token
// 无登录态，所以 token 必须不可猜（32B 随机）且永不落进日志/列表响应。

export interface InboxShare {
  id: string
  messageId: string
  name: string
  mime: string
  size: number
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}
interface StoredInboxShare extends InboxShare {
  tokenHash: string
  assetId: string
  authGeneration: number
}
interface InboxShareStoreFile {
  version: 1
  shares: StoredInboxShare[]
}
export const INBOX_SHARE_MAX_MINUTES = 10080
export const INBOX_SHARE_MIN_MINUTES = 5

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function storePath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'inbox-shares.json')
}
function publicShare(share: StoredInboxShare): InboxShare {
  const { tokenHash: _tokenHash, assetId: _assetId, authGeneration: _authGeneration, ...rest } = share
  return rest
}

class InboxShareStore {
  private filePath = storePath()
  private shares = new Map<string, StoredInboxShare>()
  private ready: Promise<void> | null = null

  private ensureReady() {
    if (!this.ready) this.ready = this.initialize()
    return this.ready
  }
  private async initialize() {
    let file: InboxShareStoreFile = { version: 1, shares: [] }
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (parsed?.version === 1 && Array.isArray(parsed.shares)) file = parsed
    } catch {}
    const now = Date.now()
    for (const share of file.shares) {
      if (
        !share ||
        typeof share.id !== 'string' ||
        typeof share.tokenHash !== 'string' ||
        typeof share.messageId !== 'string' ||
        typeof share.assetId !== 'string' ||
        typeof share.expiresAt !== 'string' ||
        typeof share.authGeneration !== 'number'
      )
        continue
      // 过期且已撤销的记录不再回读——store 只增不删会随时间变大
      if (share.revokedAt && Date.parse(share.expiresAt) < now) continue
      this.shares.set(share.id, share)
    }
  }
  private async save() {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const file: InboxShareStoreFile = {
      version: 1,
      shares: Array.from(this.shares.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }
    await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
    await chmod(this.filePath, 0o600)
  }
  private isActive(share: StoredInboxShare) {
    return !share.revokedAt && Date.parse(share.expiresAt) > Date.now() && share.authGeneration === getAuthGeneration()
  }
  async create(
    input: { messageId: string; assetId: string; name: string; mime: string; size: number },
    expiresInMinutes: number,
  ) {
    await this.ensureReady()
    const now = new Date()
    const secret = randomBytes(32).toString('base64url')
    const share: StoredInboxShare = {
      id: randomUUID(),
      tokenHash: hash(secret),
      messageId: input.messageId,
      assetId: input.assetId,
      name: input.name,
      mime: input.mime,
      size: input.size,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInMinutes * 60000).toISOString(),
      revokedAt: null,
      authGeneration: getAuthGeneration(),
    }
    this.shares.set(share.id, share)
    await this.save()
    // 对外 token = id.secret：id 定位记录，secret 参与哈希校验，二者都猜不到才算有效
    return { share: publicShare(share), token: `${share.id}.${secret}` }
  }
  async listForMessage(messageId: string) {
    await this.ensureReady()
    return Array.from(this.shares.values())
      .filter((share) => share.messageId === messageId && this.isActive(share))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicShare)
  }
  async revoke(id: string) {
    await this.ensureReady()
    const share = this.shares.get(id)
    if (!share) return false
    if (!share.revokedAt) {
      share.revokedAt = new Date().toISOString()
      await this.save()
    }
    return true
  }
  async resolve(token: string) {
    await this.ensureReady()
    const dot = token.lastIndexOf('.')
    if (dot <= 0 || dot === token.length - 1) return null
    const share = this.shares.get(token.slice(0, dot))
    if (!share || !this.isActive(share)) return null
    const candidate = hash(token.slice(dot + 1))
    if (candidate.length !== share.tokenHash.length) return null
    if (!timingSafeEqual(Buffer.from(share.tokenHash), Buffer.from(candidate))) return null
    return share
  }
}
export const inboxShareStore = new InboxShareStore()

// 分享外链直接对公众暴露：只允许低风险类型 inline 渲染（媒体/pdf/纯文本），
// 其余一律 attachment 下载；svg 虽属 image/* 但可携脚本，强制下载
export function inboxShareDisposition(mime: string) {
  const lower = (mime || '').toLowerCase()
  if (lower === 'image/svg+xml') return 'attachment' as const
  if (
    lower.startsWith('image/') ||
    lower.startsWith('video/') ||
    lower.startsWith('audio/') ||
    lower === 'application/pdf' ||
    lower === 'text/plain'
  )
    return 'inline' as const
  return 'attachment' as const
}
