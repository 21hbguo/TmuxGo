function getBrowserApiBase() {
  const protocol=window.location.protocol
  const hostname=window.location.hostname
  const port=window.location.port
  if (protocol==='https:') {
    if (port==='8443') return `${protocol}//${hostname}:8443`
    return `${protocol}//${hostname}:8443`
  }
  if (port==='3001') return `${protocol}//${hostname}:3001`
  return `${protocol}//${hostname}:3001`
}
export function getApiBase() {
  if (typeof window!=='undefined') {
    return getBrowserApiBase()
  }
  const envBase=process.env.NEXT_PUBLIC_API_URL
  if (envBase) return envBase
  return 'http://localhost:3001'
}
export function getWebSocketBase() {
  const apiBase=getApiBase()
  const base=new URL(apiBase)
  const wsProtocol=base.protocol==='https:'?'wss:':'ws:'
  return `${wsProtocol}//${base.host}/api/stream`
}
