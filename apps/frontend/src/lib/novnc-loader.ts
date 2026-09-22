import { getApiBase } from './runtime-endpoints'

export type NovncModule = typeof import('@novnc/novnc')

const STEP_TIMEOUT_MS = 5000

let modulePromise: Promise<NovncModule> | null = null

function isMobileBrowser() {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(nav.userAgent)
}

// 每一级都包独立超时：个别移动浏览器会让 import() 挂起（既不 resolve 也不 reject，
// 表现为 module map 毒化条目），之前只能靠外层 connect timeout 兜底。p.then 始终挂
// handler，超时落败的 promise 后续 reject 也不会产生 unhandled rejection
function withStepTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), STEP_TIMEOUT_MS)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

const clientModuleUrl = () => `${getApiBase()}/api/vnc/client-module`

// 首选：直接 import client-module URL。毒化条目按 URL 记，这条 URL 是全新条目天然绕开；
// 同源模块加载 cookie 随请求（未登录 401 → reject 落下一级），MIME text/javascript，
// 无 blob:/CSP 坑。rfb chunk 自包含无相对导入，可直接当被引模块
async function importApiModule(): Promise<NovncModule> {
  return (await import(/* @vite-ignore */ clientModuleUrl())) as NovncModule
}

// 兜底：fetch client-module → blob import。blob URL 每次全新也能绕开毒化条目，
// 但部分移动浏览器对 blob: 模块导入本身不可靠（vite#16140 类），仅作末级手段
async function fetchModule(): Promise<NovncModule> {
  const resp = await fetch(clientModuleUrl(), { credentials: 'include' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const blobUrl = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as NovncModule
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

// 个别移动浏览器对动态 import 的 chunk URL 会死锁（模块缓存条目毒化：请求根本不发，
// 但同 URL 的 fetch 正常）。两端降级顺序不同：
// - 移动端：api-import → fetch→blob → 静态 chunk（毒化高发路径放最后）
// - 桌面端：静态 chunk 几乎总能成功（原 5s 竞速语义由统一超时保留）→ api-import → blob
async function load(): Promise<NovncModule> {
  const steps: Array<[string, () => Promise<NovncModule>]> = isMobileBrowser()
    ? [
        ['api-import', importApiModule],
        ['blob', fetchModule],
        ['chunk', () => import('@novnc/novnc')],
      ]
    : [
        ['chunk', () => import('@novnc/novnc')],
        ['api-import', importApiModule],
        ['blob', fetchModule],
      ]
  const errors: string[] = []
  for (const [stage, run] of steps) {
    try {
      return await withStepTimeout(run())
    } catch (err) {
      errors.push(`${stage}=${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`novnc load failed: ${errors.join(', ')}`)
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
