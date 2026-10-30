import { getApiBase } from './runtime-endpoints'

export interface RawUrlOptions {
  download?: boolean
  /** 仅 cache-bust：内容不变时 ETag/304 仍然生效 */
  v?: string
}

/**
 * /files/raw 的 URL 构造：路径按段编码，保留 `/` 分隔。
 * 不能用 encodeURIComponent(path) —— 那样分隔符会被编码成 %2F，通配路由拿不到层级。
 */
export function buildRawUrl(hostId: string, rootId: string, path: string, opts: RawUrlOptions = {}): string {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const query = new URLSearchParams()
  if (opts.download) query.set('download', '1')
  if (opts.v) query.set('v', opts.v)
  const suffix = query.toString()
  return `${getApiBase()}/api/hosts/${encodeURIComponent(hostId)}/files/raw/${encodeURIComponent(rootId)}/${segments}${suffix ? `?${suffix}` : ''}`
}
