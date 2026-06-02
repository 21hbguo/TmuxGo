import { useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { GitHostState } from '@/types'

const PROFILE = 'default'
const PUSH_DEBOUNCE_MS = 400

function sanitizeGitByHost(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const next: Record<string, GitHostState> = {}
  for (const [hostId, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') continue
    const raw = value as Record<string, unknown>
    const recentReposRaw = Array.isArray(raw.recentRepos) ? raw.recentRepos : []
    next[hostId] = {
      mode: raw.mode === 'locked' ? 'locked' : 'follow-editor',
      currentRepoPath: typeof raw.currentRepoPath === 'string' && raw.currentRepoPath ? raw.currentRepoPath : null,
      currentFilePath: typeof raw.currentFilePath === 'string' && raw.currentFilePath ? raw.currentFilePath : null,
      source: raw.source === 'editor' || raw.source === 'manual' ? raw.source : null,
      lockedRepoPath: typeof raw.lockedRepoPath === 'string' && raw.lockedRepoPath ? raw.lockedRepoPath : null,
      recentRepos: recentReposRaw.filter((entry): entry is GitHostState['recentRepos'][number] => !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).repoPath === 'string').map((entry) => ({
        repoPath: entry.repoPath,
        label: typeof entry.label === 'string' && entry.label ? entry.label : entry.repoPath.split('/').filter(Boolean).pop() || entry.repoPath,
        lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
        pinned: entry.pinned === true,
      })).slice(0, 12),
    }
  }
  return next
}

export function useGitPreferencesSync() {
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const replaceGitByHost = useConsoleStore((state) => state.replaceGitByHost)
  const hydratedRef = useRef(false)
  const lastPushedRef = useRef('')
  const gitByHostRef = useRef(gitByHost)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    gitByHostRef.current = gitByHost
  }, [gitByHost])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const remote = await api.preferences.get(PROFILE)
        if (cancelled) return
        const remoteGit = sanitizeGitByHost(remote.gitByHost)
        lastPushedRef.current = JSON.stringify(remoteGit)
        replaceGitByHost(remoteGit)
      } catch {
      } finally {
        if (!cancelled) hydratedRef.current = true
      }
    })()
    return () => { cancelled = true }
  }, [replaceGitByHost])

  useEffect(() => {
    if (!hydratedRef.current) return
    const serialized = JSON.stringify(gitByHost)
    if (serialized === lastPushedRef.current) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const nextSerialized = JSON.stringify(gitByHostRef.current)
      if (nextSerialized === lastPushedRef.current) return
      const nextUpdatedAt = new Date().toISOString()
      lastPushedRef.current = nextSerialized
      void api.preferences.update({ gitByHost: gitByHostRef.current, gitByHostUpdatedAt: nextUpdatedAt }, PROFILE).catch(() => {
        lastPushedRef.current = ''
      })
    }, PUSH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [gitByHost])
}
