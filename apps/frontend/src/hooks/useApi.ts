import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { SessionLayout } from '@/types'
import type { GitBranchesResponse, GitCommitResponse, GitDetectResponse, GitDiffResponse, GitLogResponse, GitMergeResponse, GitStatusResponse } from '@/types'

function upsertSessionList(prev: any[] | undefined, session: any) {
  if (!session?.id) return prev || []
  if (!Array.isArray(prev) || prev.length === 0) return [session]
  if (prev.some((item) => item?.id === session.id)) return prev.map((item) => item?.id === session.id ? { ...item, ...session } : item)
  return [...prev, session]
}
function removeSessionListItem(prev: any[] | undefined, sessionId: string) {
  if (!Array.isArray(prev) || !sessionId) return prev || []
  return prev.filter((item) => item?.id !== sessionId)
}
function clearSessionQueries(queryClient: ReturnType<typeof useQueryClient>, hostId: string, sessionId: string) {
  queryClient.removeQueries({ queryKey: ['session-snapshot', hostId, sessionId] })
  queryClient.removeQueries({ queryKey: ['windows', hostId, sessionId] })
  queryClient.removeQueries({ queryKey: ['session-panes', hostId, sessionId] })
}

export function useHosts() {
  return useQuery({
    queryKey: ['hosts'],
    queryFn: api.hosts.list,
    staleTime: 60000,
  })
}

export function useHost(id: string) {
  return useQuery({
    queryKey: ['host', id],
    queryFn: () => api.hosts.get(id),
    enabled: !!id,
    staleTime: 60000,
  })
}
export function useCreateHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: { id: string; name?: string; address: string; user: string; port?: number; password?: string; passwordEnv?: string }) =>
      api.hosts.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
}
export function useDeleteHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (hostId: string) =>
      api.hosts.remove(hostId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
}
export function useTestHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (hostId: string) =>
      api.hosts.test(hostId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
}
export function useRestartRebuildStatus(enabled = true, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ['restart-rebuild-status'],
    queryFn: api.system.restartRebuildStatus,
    enabled,
    staleTime: 0,
    refetchInterval,
  })
}
export function useRestartRebuild() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.system.restartRebuild(),
    onSuccess: (data) => {
      queryClient.setQueryData(['restart-rebuild-status'], data)
    },
  })
}

export function useSessions(hostId: string) {
  return useQuery({
    queryKey: ['sessions', hostId],
    queryFn: () => api.sessions.list(hostId),
    enabled: !!hostId,
    staleTime: 4000,
  })
}
export function useSessionThumbnails(hostId: string, enabled = true) {
  return useQuery({
    queryKey: ['session-thumbnails', hostId],
    queryFn: () => api.sessions.thumbnails(hostId),
    enabled: !!hostId && enabled,
    staleTime: 0,
    refetchInterval: enabled ? 2000 : false,
    refetchIntervalInBackground: false,
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, name, layout }: { hostId: string; name: string; layout?: SessionLayout }) =>
      api.sessions.create(hostId, name, layout),
    onSuccess: (created, { hostId }) => {
      queryClient.setQueryData(['sessions', hostId], (prev: any[] | undefined) => upsertSessionList(prev, created))
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}
export function useDeleteSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, sessionId }: { hostId: string; sessionId: string }) =>
      api.sessions.delete(hostId, sessionId),
    onSuccess: (_, { hostId, sessionId }) => {
      queryClient.setQueryData(['sessions', hostId], (prev: any[] | undefined) => removeSessionListItem(prev, sessionId))
      clearSessionQueries(queryClient, hostId, sessionId)
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}
export function useBatchDeleteSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, payload }: { hostId: string; payload: { mode?: 'preview' | 'execute'; sessionIds?: string[]; filters?: { createdBefore?: string; inactiveBefore?: string; nameIncludes?: string; includeAttached?: boolean }; limit?: number; force?: boolean } }) =>
      api.sessions.batchDelete(hostId, payload),
    onSuccess: (result, { hostId, payload }) => {
      if (result.mode === 'execute') {
        const deletedIds = new Set((result.deleted || []).map((item) => item.sessionId).filter(Boolean))
        if (deletedIds.size) {
          queryClient.setQueryData(['sessions', hostId], (prev: any[] | undefined) => Array.isArray(prev) ? prev.filter((item) => !deletedIds.has(item?.id)) : prev || [])
          Array.from(deletedIds).forEach((sessionId) => clearSessionQueries(queryClient, hostId, sessionId))
        } else if (Array.isArray(payload.sessionIds) && payload.sessionIds.length) {
          queryClient.setQueryData(['sessions', hostId], (prev: any[] | undefined) => Array.isArray(prev) ? prev.filter((item) => !payload.sessionIds?.includes(item?.id)) : prev || [])
        }
      }
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}
export function useRenameSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, sessionId, name }: { hostId: string; sessionId: string; name: string }) =>
      api.sessions.rename(hostId, sessionId, name),
    onSuccess: (renamed, { hostId, sessionId }) => {
      queryClient.setQueryData(['sessions', hostId], (prev: any[] | undefined) => {
        const next = upsertSessionList(removeSessionListItem(prev, sessionId), renamed)
        return next
      })
      if (renamed?.id && renamed.id !== sessionId) clearSessionQueries(queryClient, hostId, sessionId)
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}

export function useWindows(hostId: string, sessionId: string) {
  return useQuery({
    queryKey: ['windows', hostId, sessionId],
    queryFn: () => api.windows.list(hostId, sessionId),
    enabled: !!hostId && !!sessionId,
    staleTime: 2500,
  })
}

export function usePanes(windowId: string) {
  return useQuery({
    queryKey: ['panes', windowId],
    queryFn: () => api.panes.list(windowId),
    enabled: !!windowId,
    staleTime: 1500,
  })
}

export function useSessionPanes(hostId: string, sessionId: string) {
  return useQuery({
    queryKey: ['session-panes', hostId, sessionId],
    queryFn: () => api.panes.listBySession(hostId, sessionId),
    enabled: !!hostId && !!sessionId,
    staleTime: 1500,
  })
}

export function useSessionSnapshot(hostId: string, sessionId: string) {
  return useQuery({
    queryKey: ['session-snapshot', hostId, sessionId],
    queryFn: () => api.snapshot.get(hostId, sessionId),
    enabled: !!hostId && !!sessionId,
    staleTime: 1200,
  })
}

export function useFileRoots(hostId = 'local') {
  return useQuery({
    queryKey: ['file-roots', hostId],
    queryFn: () => api.files.roots(hostId),
    staleTime: 60000,
  })
}

export function useFileList(hostId: string, root: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ['file-list', hostId, root, path],
    queryFn: () => api.files.list(hostId, root, path),
    enabled: !!root && enabled,
    staleTime: 8000,
    gcTime: 60000,
  })
}

export function useFilePreview(hostId: string, root: string, path: string, line = 1, enabled = true) {
  return useQuery({
    queryKey: ['file-preview', hostId, root, path, line],
    queryFn: () => api.files.preview(hostId, root, path, line),
    enabled: !!root && !!path && enabled,
    staleTime: 8000,
    gcTime: 60000,
  })
}

export function useFileSearch(hostId: string, root: string, mode: 'name' | 'content', query: string, basePath = '', includeDotFiles = true) {
  return useQuery({
    queryKey: ['file-search', hostId, root, mode, query, basePath, includeDotFiles],
    queryFn: () => mode === 'name' ? api.files.searchName(hostId, root, query, basePath, includeDotFiles) : api.files.searchContent(hostId, root, query, basePath, includeDotFiles),
    enabled: !!root && query.trim().length > 0,
    staleTime: 8000,
    gcTime: 60000,
  })
}

// Git hooks
export function useGitDetect(hostId: string, path: string) {
  return useQuery({
    queryKey: ['git-detect', hostId, path],
    queryFn: () => api.git.detect(hostId, path),
    enabled: !!hostId && !!path,
    staleTime: 60000,
  })
}

export function useGitStatus(hostId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ['git-status', hostId, path],
    queryFn: () => api.git.status(hostId, path),
    enabled: !!hostId && !!path && enabled,
    staleTime: 5000,
    refetchInterval: 10000,
  })
}

export function useGitDiff(hostId: string, path: string, options?: { filePath?: string; staged?: boolean; commit?: string }, enabled = true) {
  return useQuery({
    queryKey: ['git-diff', hostId, path, options?.filePath, options?.staged, options?.commit],
    queryFn: () => api.git.diff(hostId, path, options),
    enabled: !!hostId && !!path && enabled,
    staleTime: 5000,
  })
}

export function useGitStage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, filePaths }: { hostId: string; path: string; filePaths: string[] }) => api.git.stage(hostId, path, filePaths),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-diff', hostId, path] }) },
  })
}

export function useGitUnstage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, filePaths }: { hostId: string; path: string; filePaths: string[] }) => api.git.unstage(hostId, path, filePaths),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-diff', hostId, path] }) },
  })
}

export function useGitCommit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, message, amend }: { hostId: string; path: string; message: string; amend?: boolean }) => api.git.commit(hostId, path, message, amend),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-diff', hostId, path] }) },
  })
}

export function useGitDiscard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, filePaths }: { hostId: string; path: string; filePaths: string[] }) => api.git.discard(hostId, path, filePaths),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-diff', hostId, path] }) },
  })
}

export function useGitLog(hostId: string, path: string, options?: { limit?: number; skip?: number }, enabled = true) {
  return useQuery({
    queryKey: ['git-log', hostId, path, options?.limit, options?.skip],
    queryFn: () => api.git.log(hostId, path, options),
    enabled: !!hostId && !!path && enabled,
    staleTime: 10000,
  })
}

export function useGitBranches(hostId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ['git-branches', hostId, path],
    queryFn: () => api.git.branches(hostId, path),
    enabled: !!hostId && !!path && enabled,
    staleTime: 10000,
  })
}

export function useGitCheckout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, branch }: { hostId: string; path: string; branch: string }) => api.git.checkout(hostId, path, branch),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-branches', hostId, path] }) },
  })
}

export function useGitCreateBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, name, startPoint }: { hostId: string; path: string; name: string; startPoint?: string }) => api.git.createBranch(hostId, path, name, startPoint),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-branches', hostId, path] }) },
  })
}

export function useGitDeleteBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, name, force }: { hostId: string; path: string; name: string; force?: boolean }) => api.git.deleteBranch(hostId, path, name, force),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-branches', hostId, path] }) },
  })
}

export function useGitMerge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, branch, noFF }: { hostId: string; path: string; branch: string; noFF?: boolean }) => api.git.merge(hostId, path, branch, noFF),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-branches', hostId, path] }) },
  })
}

export function useGitFetch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, remote, prune }: { hostId: string; path: string; remote?: string; prune?: boolean }) => api.git.fetch(hostId, path, { remote, prune }),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-branches', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }) },
  })
}

export function useGitPull() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, path, remote, branch, rebase }: { hostId: string; path: string; remote?: string; branch?: string; rebase?: boolean }) => api.git.pull(hostId, path, { remote, branch, rebase }),
    onSuccess: (_, { hostId, path }) => { qc.invalidateQueries({ queryKey: ['git-status', hostId, path] }); qc.invalidateQueries({ queryKey: ['git-log', hostId, path] }) },
  })
}

export function useGitPush() {
  return useMutation({
    mutationFn: ({ hostId, path, remote, branch, force, setUpstream }: { hostId: string; path: string; remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }) => api.git.push(hostId, path, { remote, branch, force, setUpstream }),
  })
}
