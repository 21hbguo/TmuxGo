import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

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

export function useSessions(hostId: string) {
  return useQuery({
    queryKey: ['sessions', hostId],
    queryFn: () => api.sessions.list(hostId),
    enabled: !!hostId,
    staleTime: 4000,
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ hostId, name, layout }: { hostId: string; name: string; layout?: { windows: { name: string; panes: { command?: string }[] }[] } }) =>
      api.sessions.create(hostId, name, layout),
    onSuccess: (_, { hostId }) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ hostId, sessionId }: { hostId: string; sessionId: string }) =>
      api.sessions.delete(hostId, sessionId),
    onSuccess: (_, { hostId }) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', hostId] })
    },
  })
}
export function useRenameSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ hostId, sessionId, name }: { hostId: string; sessionId: string; name: string }) =>
      api.sessions.rename(hostId, sessionId, name),
    onSuccess: (_, { hostId }) => {
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

export function useFileRoots() {
  return useQuery({
    queryKey: ['file-roots'],
    queryFn: api.files.roots,
    staleTime: 60000,
  })
}

export function useFileList(root: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ['file-list', root, path],
    queryFn: () => api.files.list(root, path),
    enabled: !!root && enabled,
    staleTime: 8000,
    gcTime: 60000,
  })
}

export function useFilePreview(root: string, path: string, line = 1, enabled = true) {
  return useQuery({
    queryKey: ['file-preview', root, path, line],
    queryFn: () => api.files.preview(root, path, line),
    enabled: !!root && !!path && enabled,
    staleTime: 8000,
    gcTime: 60000,
  })
}

export function useFileSearch(root: string, mode: 'name' | 'content', query: string, basePath = '') {
  return useQuery({
    queryKey: ['file-search', root, mode, query, basePath],
    queryFn: () => mode === 'name' ? api.files.searchName(root, query, basePath) : api.files.searchContent(root, query, basePath),
    enabled: !!root && query.trim().length > 1,
    staleTime: 8000,
    gcTime: 60000,
  })
}
