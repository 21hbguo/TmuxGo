import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

export function useHosts() {
  return useQuery({
    queryKey: ['hosts'],
    queryFn: api.hosts.list,
  })
}

export function useHost(id: string) {
  return useQuery({
    queryKey: ['host', id],
    queryFn: () => api.hosts.get(id),
    enabled: !!id,
  })
}

export function useSessions(hostId: string) {
  return useQuery({
    queryKey: ['sessions', hostId],
    queryFn: () => api.sessions.list(hostId),
    enabled: !!hostId,
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ hostId, name }: { hostId: string; name: string }) =>
      api.sessions.create(hostId, name),
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

export function useWindows(hostId: string, sessionId: string) {
  return useQuery({
    queryKey: ['windows', hostId, sessionId],
    queryFn: () => api.windows.list(hostId, sessionId),
    enabled: !!hostId && !!sessionId,
  })
}

export function usePanes(windowId: string) {
  return useQuery({
    queryKey: ['panes', windowId],
    queryFn: () => api.panes.list(windowId),
    enabled: !!windowId,
  })
}

export function useSessionPanes(hostId: string, sessionId: string) {
  return useQuery({
    queryKey: ['session-panes', hostId, sessionId],
    queryFn: () => api.panes.listBySession(hostId, sessionId),
    enabled: !!hostId && !!sessionId,
  })
}
