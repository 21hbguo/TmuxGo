function getBrowserApiBase() {
  const envBase=process.env.NEXT_PUBLIC_API_URL
  if (envBase) return envBase
  const protocol=window.location.protocol==='https:'?'https:':'http:'
  const port=protocol==='https:'?'8443':'3001'
  return `${protocol}//${window.location.hostname}:${port}`
}
export function getApiBase() {
  if (typeof window!=='undefined') {
    return getBrowserApiBase()
  }
  const envBase=process.env.NEXT_PUBLIC_API_URL
  if (envBase) return envBase
  return 'http://127.0.0.1:3001'
}
export function getWebSocketBase() {
  if (typeof window!=='undefined') {
    const protocol=window.location.protocol==='https:'?'wss:':'ws:'
    return `${protocol}//${window.location.host}/api/stream`
  }
  const apiBase=getApiBase()
  const base=new URL(apiBase)
  const wsProtocol=base.protocol==='https:'?'wss:':'ws:'
  return `${wsProtocol}//${base.host}/api/stream`
}
