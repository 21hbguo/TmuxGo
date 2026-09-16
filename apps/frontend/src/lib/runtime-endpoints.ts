function getBrowserApiBase() {
  const envBase = import.meta.env.VITE_API_URL
  if (envBase) return envBase
  return window.location.origin
}
export function getApiBase() {
  if (typeof window !== 'undefined') {
    return getBrowserApiBase()
  }
  const envBase = import.meta.env.VITE_API_URL
  if (envBase) return envBase
  return 'http://127.0.0.1:3001'
}
function getWebSocketOrigin() {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}`
  }
  const apiBase = getApiBase()
  const base = new URL(apiBase)
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${base.host}`
}
export function getWebSocketBase() {
  return `${getWebSocketOrigin()}/api/stream`
}
export function getVncWebSocketBase(hostId: string, port: number) {
  return `${getWebSocketOrigin()}/api/vnc?hostId=${encodeURIComponent(hostId)}&port=${port}`
}
