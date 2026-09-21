import { getApiBase } from './runtime-endpoints'

export type NovncModule = typeof import('@novnc/novnc')

const DIRECT_IMPORT_TIMEOUT_MS = 5000

let modulePromise: Promise<NovncModule> | null = null

// 个别移动浏览器对动态 import 的 chunk URL 会死锁（模块缓存条目毒化：请求根本不发，
// 但同 URL 的 fetch 正常）。import 竞速超时后改走 fetch→blob import 兜底。
async function load(): Promise<NovncModule> {
  const direct = import('@novnc/novnc')
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      direct,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('novnc import timeout')), DIRECT_IMPORT_TIMEOUT_MS)
      }),
    ])
  } catch {
    // direct 竞速落败后仍 pending/晚到 reject，挂空 catch 防 unhandled rejection
    direct.catch(() => {})
    const resp = await fetch(`${getApiBase()}/api/vnc/client-module`, { credentials: 'include' })
    if (!resp.ok) throw new Error(`novnc client-module HTTP ${resp.status}`)
    // rfb chunk 自包含无相对导入，blob import 安全；毒化路径是普通 import 的 URL 缓存条目
    const blobUrl = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/javascript' }))
    return (await import(/* @vite-ignore */ blobUrl)) as NovncModule
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function loadNovnc(): Promise<NovncModule> {
  if (!modulePromise) {
    const p = load()
    modulePromise = p
    // 失败不缓存，下次 connect 可重试
    p.catch(() => {
      if (modulePromise === p) modulePromise = null
    })
  }
  return modulePromise
}
