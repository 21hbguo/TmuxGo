import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'

type CustomShortcut = { id: string; label: string; keys: string }
type FavoriteDirectory = { rootId: string; rootPath: string; name: string; path: string }
type PreferencesStore = {
  version: 1
  updatedAt: string
  customShortcuts: CustomShortcut[]
  customShortcutsUpdatedAt: string
  favoriteDirectories: FavoriteDirectory[]
  favoriteDirectoriesUpdatedAt: string
  uploadRateLimitKBps: number
}

const MAX_SHORTCUTS = 100
const MAX_FAVORITES = 100
const MAX_BODY_BYTES = 256 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_PROFILE_LEN = 64
const MAX_SHORTCUT_LABEL_LEN = 64
const MAX_SHORTCUT_KEYS_LEN = 64
const MAX_ID_LEN = 64
const MAX_ROOT_ID_LEN = 64
const MAX_ROOT_PATH_LEN = 1024
const MAX_FAVORITE_NAME_LEN = 128
const MAX_FAVORITE_PATH_LEN = 1024
const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 200
const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
const PROFILE_RE = /^[a-zA-Z0-9_-]+$/
const STORAGE_DIR = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')

function nowIso() {
  return new Date().toISOString()
}
function getDefaultStore(): PreferencesStore {
  const now = nowIso()
  return {
    version: 1,
    updatedAt: now,
    customShortcuts: [],
    customShortcutsUpdatedAt: now,
    favoriteDirectories: [],
    favoriteDirectoriesUpdatedAt: now,
    uploadRateLimitKBps: DEFAULT_UPLOAD_RATE_LIMIT_KBPS,
  }
}
function safeString(input: unknown, maxLen: number) {
  if (typeof input !== 'string') return ''
  return input.trim().slice(0, maxLen)
}
function normalizeIso(input: unknown, fallback: string) {
  if (typeof input !== 'string') return fallback
  const t = Date.parse(input)
  if (Number.isNaN(t)) return fallback
  return new Date(t).toISOString()
}
function parseIsoMs(input: string) {
  const t = Date.parse(input)
  return Number.isNaN(t) ? 0 : t
}
function normalizeShortcuts(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: CustomShortcut[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const id = safeString((entry as Record<string, unknown>).id, MAX_ID_LEN)
    const label = safeString((entry as Record<string, unknown>).label, MAX_SHORTCUT_LABEL_LEN)
    const keys = safeString((entry as Record<string, unknown>).keys, MAX_SHORTCUT_KEYS_LEN)
    if (!id || !label || !keys) continue
    next.push({ id, label, keys })
    if (next.length >= MAX_SHORTCUTS) break
  }
  return next
}
function normalizeFavorites(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: FavoriteDirectory[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const rootId = safeString((entry as Record<string, unknown>).rootId, MAX_ROOT_ID_LEN)
    const rootPath = safeString((entry as Record<string, unknown>).rootPath, MAX_ROOT_PATH_LEN)
    const name = safeString((entry as Record<string, unknown>).name, MAX_FAVORITE_NAME_LEN)
    const pathValue = safeString((entry as Record<string, unknown>).path, MAX_FAVORITE_PATH_LEN)
    if (!rootId || !rootPath || !name) continue
    next.push({ rootId, rootPath, name, path: pathValue })
    if (next.length >= MAX_FAVORITES) break
  }
  return next
}
function normalizeUploadRateLimitKBps(input: unknown) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  return Math.max(1, Math.min(MAX_UPLOAD_RATE_LIMIT_KBPS, Math.round(value)))
}
function normalizeStore(input: unknown): PreferencesStore {
  const fallback = getDefaultStore()
  if (!input || typeof input !== 'object') return fallback
  const raw = input as Record<string, unknown>
  const customShortcutsUpdatedAt = normalizeIso(raw.customShortcutsUpdatedAt, fallback.customShortcutsUpdatedAt)
  const favoriteDirectoriesUpdatedAt = normalizeIso(raw.favoriteDirectoriesUpdatedAt, fallback.favoriteDirectoriesUpdatedAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt, fallback.updatedAt)
  const updatedAt = new Date(Math.max(parseIsoMs(updatedAtRaw), parseIsoMs(customShortcutsUpdatedAt), parseIsoMs(favoriteDirectoriesUpdatedAt))).toISOString()
  return {
    version: 1,
    updatedAt,
    customShortcuts: normalizeShortcuts(raw.customShortcuts),
    customShortcutsUpdatedAt,
    favoriteDirectories: normalizeFavorites(raw.favoriteDirectories),
    favoriteDirectoriesUpdatedAt,
    uploadRateLimitKBps: normalizeUploadRateLimitKBps(raw.uploadRateLimitKBps),
  }
}
function getProfileName(input: unknown) {
  const profile = safeString(input, MAX_PROFILE_LEN) || 'default'
  if (!PROFILE_RE.test(profile)) return 'default'
  return profile
}
function getProfilePath(profile: string) {
  return path.join(STORAGE_DIR, `${profile}.json`)
}
async function ensureStorageDir() {
  await mkdir(STORAGE_DIR, { recursive: true })
}
async function readStore(profile: string) {
  const file = getProfilePath(profile)
  try {
    const content = await readFile(file, 'utf8')
    return normalizeStore(JSON.parse(content))
  } catch {
    return getDefaultStore()
  }
}
async function writeStore(profile: string, store: PreferencesStore) {
  await ensureStorageDir()
  const file = getProfilePath(profile)
  const data = JSON.stringify(store)
  if (Buffer.byteLength(data, 'utf8') > MAX_FILE_BYTES) throw new Error('Preferences too large')
  const tmp = `${file}.tmp-${Date.now().toString(36)}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, file)
  try {
    const info = await stat(file)
    if (info.size > MAX_FILE_BYTES) throw new Error('Preferences too large')
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error('Failed to verify preferences file')
  }
}

export async function preferencesRoutes(fastify: FastifyInstance) {
  fastify.get('/preferences', async (request) => {
    const query = request.query as { profile?: string }
    const profile = getProfileName(query.profile)
    return readStore(profile)
  })
  fastify.put('/preferences', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const query = request.query as { profile?: string }
    const profile = getProfileName(query.profile)
    const body = (request.body && typeof request.body === 'object') ? request.body as Record<string, unknown> : {}
    const current = await readStore(profile)
    const next = { ...current }
    if ('customShortcuts' in body) {
      const incoming = normalizeShortcuts(body.customShortcuts)
      const incomingAt = normalizeIso(body.customShortcutsUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.customShortcutsUpdatedAt)) {
        next.customShortcuts = incoming
        next.customShortcutsUpdatedAt = incomingAt
      }
    }
    if ('favoriteDirectories' in body) {
      const incoming = normalizeFavorites(body.favoriteDirectories)
      const incomingAt = normalizeIso(body.favoriteDirectoriesUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.favoriteDirectoriesUpdatedAt)) {
        next.favoriteDirectories = incoming
        next.favoriteDirectoriesUpdatedAt = incomingAt
      }
    }
    if ('uploadRateLimitKBps' in body) next.uploadRateLimitKBps = normalizeUploadRateLimitKBps(body.uploadRateLimitKBps)
    next.updatedAt = new Date(Math.max(parseIsoMs(next.customShortcutsUpdatedAt), parseIsoMs(next.favoriteDirectoriesUpdatedAt))).toISOString()
    try {
      await writeStore(profile, next)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save preferences'
      return reply.code(413).send({ message, code: 'PREFERENCES_TOO_LARGE' })
    }
    return next
  })
}
