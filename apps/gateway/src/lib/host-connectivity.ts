export interface HostConnectivity {
  status: 'online' | 'offline'
  latencyMs?: number
  lastCheckedAt: string
  lastError?: string
  dependencies?: Record<string, boolean>
}

const connectivity = new Map<string, HostConnectivity>()
const connectionFailures = new Set(['Host key verification failed', 'SSH connection timed out', 'SSH network is unreachable', 'SSH authentication failed', 'SSH private key is unavailable'])

export function getHostConnectivity(hostId: string) {
  return connectivity.get(hostId)
}

export function setHostConnectivity(hostId: string, value: HostConnectivity) {
  connectivity.set(hostId, value)
}

export function recordHostConnectionFailure(hostId: string, message: string) {
  if (!connectionFailures.has(message)) return
  const previous = connectivity.get(hostId)
  connectivity.set(hostId, { status: 'offline', latencyMs: previous?.latencyMs, lastCheckedAt: new Date().toISOString(), lastError: message, dependencies: previous?.dependencies })
}

export function removeHostConnectivity(hostId: string) {
  connectivity.delete(hostId)
}
