function normalizeOrigin(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}
function hostMatchesOrigin(host: string | undefined, originHostname: string) {
  if (!host) return false
  try {
    return new URL(`http://${host}`).hostname.toLowerCase() === originHostname
  } catch {
    return false
  }
}
export function isRequestOriginAllowed(origin: string | undefined, host: string | undefined, allowedOrigins = process.env.TMUXGO_ALLOWED_ORIGINS || '', forwardedHost?: string, remoteAddress?: string) {
  if (!origin) return true
  const originUrl = normalizeOrigin(origin)
  if (!originUrl) return false
  const configured = allowedOrigins.split(',').map((item) => item.trim()).filter(Boolean)
  if (configured.includes('*')) return true
  if (configured.some((item) => normalizeOrigin(item)?.origin === originUrl.origin)) return true
  if (hostMatchesOrigin(host, originUrl.hostname.toLowerCase())) return true
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') return false
  return hostMatchesOrigin(forwardedHost?.split(',')[0]?.trim(), originUrl.hostname.toLowerCase())
}
