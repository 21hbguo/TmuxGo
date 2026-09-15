import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import path from 'path'
const execFileAsync = promisify(execFile)
export interface AppUpdateRef {
  version: string
  buildId: string
  commit: string
}
export interface AppUpdateStatus {
  available: boolean
  branch: string | null
  aheadBy: number
  behindBy: number
  dirty: boolean
  checkedAt: string | null
  error: string | null
  current: AppUpdateRef
  latest: AppUpdateRef | null
}
interface UpdateCheckerOptions {
  rootDir?: string
  fetchMinIntervalMs?: number
  fetchTimeoutMs?: number
}
async function git(rootDir: string, args: string[], timeoutMs = 10000) {
  const { stdout } = await execFileAsync('git', args, { cwd: rootDir, timeout: timeoutMs, env: process.env })
  return stdout.toString().trim()
}
async function readVersion(rootDir: string, ref: string | null) {
  try {
    const raw = ref ? await git(rootDir, ['show', `${ref}:apps/frontend/package.json`]) : await readFile(path.join(rootDir, 'apps/frontend/package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'dev'
  } catch {
    return 'dev'
  }
}
export function createUpdateChecker(options: UpdateCheckerOptions = {}) {
  const rootDir = options.rootDir || path.resolve(process.cwd(), '..', '..')
  const fetchMinIntervalMs = options.fetchMinIntervalMs ?? 45000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 25000
  let lastFetchAt = 0
  let cachedRemote: { commit: string; version: string; aheadBy: number; behindBy: number } | null = null
  let lastError: string | null = null
  async function localStatus() {
    const [branch, commit, porcelain, version] = await Promise.all([
      git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      git(rootDir, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
      git(rootDir, ['status', '--porcelain']).catch(() => ''),
      readVersion(rootDir, null),
    ])
    return { branch: branch && branch !== 'HEAD' ? branch : null, commit, dirty: porcelain.length > 0, current: { version, buildId: commit ? `${version}-${commit}` : version, commit } }
  }
  async function resolveUpstream() {
    try {
      return await git(rootDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    } catch {}
    const { branch } = await localStatus()
    if (branch) {
      try {
        await git(rootDir, ['rev-parse', '--verify', `origin/${branch}`])
        return `origin/${branch}`
      } catch {}
    }
    return ''
  }
  async function readRemote(ref: string) {
    const commit = await git(rootDir, ['rev-parse', '--short', ref])
    const counts = await git(rootDir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])
    const [aheadBy, behindBy] = counts.split(/\s+/).map((part) => Math.max(0, parseInt(part, 10) || 0))
    const version = await readVersion(rootDir, ref)
    return { commit, version, aheadBy, behindBy }
  }
  async function fetchRemote() {
    const upstream = await resolveUpstream()
    if (upstream) {
      await git(rootDir, ['fetch', '--quiet', upstream.split('/')[0]], fetchTimeoutMs)
      return readRemote(upstream)
    }
    const { branch } = await localStatus()
    await git(rootDir, ['fetch', '--quiet', 'origin', branch || 'HEAD'], fetchTimeoutMs)
    return readRemote('FETCH_HEAD')
  }
  return {
    async getStatus(force = false): Promise<AppUpdateStatus> {
      const local = await localStatus()
      if (force || Date.now() - lastFetchAt >= fetchMinIntervalMs) {
        lastFetchAt = Date.now()
        try {
          cachedRemote = await fetchRemote()
          lastError = null
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unable to check remote'
          if (!cachedRemote) {
            try {
              const staleRef = await resolveUpstream()
              if (staleRef) cachedRemote = await readRemote(staleRef)
            } catch {}
          }
        }
      }
      const latest = cachedRemote ? { version: cachedRemote.version, buildId: `${cachedRemote.version}-${cachedRemote.commit}`, commit: cachedRemote.commit } : null
      return {
        available: (cachedRemote?.behindBy ?? 0) > 0,
        branch: local.branch,
        aheadBy: cachedRemote?.aheadBy ?? 0,
        behindBy: cachedRemote?.behindBy ?? 0,
        dirty: local.dirty,
        checkedAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
        error: lastError,
        current: local.current,
        latest,
      }
    },
  }
}
export type UpdateChecker = ReturnType<typeof createUpdateChecker>
