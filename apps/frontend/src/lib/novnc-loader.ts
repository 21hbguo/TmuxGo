import { getApiBase } from './runtime-endpoints'
import { APP_BUILD_ID } from './app-version'

export type NovncModule = typeof import('@novnc/novnc')

const STEP_TIMEOUT_MS = 5000
// script 注入级取回模块时挂的 window 全局名（见 src/novnc-iife.ts）
const NOVNC_GLOBAL = '__TMUXGO_NOVNC__'

let modulePromise: Promise<NovncModule> | null = null

function isMobileBrowser() {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(nav.userAgent)
}

// 每一级都包独立超时：个别移动浏览器会让 import() / script.onload 挂起（既不 resolve
// 也不 reject），之前只能靠外层 connect timeout 兜底。p.then 始终挂 handler，超时落败
// 的 promise 后续 reject 也不会产生 unhandled rejection
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

// 直导 client-module URL：module map 毒化按 URL 记条目，这条 URL 是全新条目天然绕开；
// 同源模块加载 cookie 随请求（未登录 401 → reject 落下一级），MIME text/javascript。
// rfb chunk 自包含无相对导入，可直接当被引模块
async function importApiModule(): Promise<NovncModule> {
  return (await import(/* @vite-ignore */ clientModuleUrl())) as NovncModule
}

// 经典 <script src> 注入 dist/novnc-rfb.js（IIFE bundle）：完全不经过 module
// machinery——真机实测部分浏览器动态 import() 整体死锁（api/blob/chunk 三级全 timeout），
// 但经典 script 标签加载正常。?v=buildId 防缓存旧文件（文件名无 hash）
function injectScript(): Promise<NovncModule> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${getApiBase()}/novnc-rfb.js?v=${APP_BUILD_ID}`
    script.onload = () => {
      const mod = (window as any)[NOVNC_GLOBAL]
      if (mod) resolve(mod as NovncModule)
      else reject(new Error('no global'))
    }
    script.onerror = () => reject(new Error('script error'))
    document.head.appendChild(script)
  })
}

// 个别移动浏览器对动态 import 整体死锁（module map 毒化：请求根本不发，静态 module
// 图不受影响——app 本体就是 script type=module 起来的）。两端降级顺序不同：
// - 移动端：script-iife → api-import → chunk（module loader 相关的全放后面兜底）
// - 桌面端：chunk 几乎总能成功（原竞速语义由统一 5s 超时保留）→ api-import → script-iife
async function load(): Promise<NovncModule> {
  const steps: Array<[string, () => Promise<NovncModule>]> = isMobileBrowser()
    ? [
        ['script-iife', injectScript],
        ['api-import', importApiModule],
        ['chunk', () => import('@novnc/novnc')],
      ]
    : [
        ['chunk', () => import('@novnc/novnc')],
        ['api-import', importApiModule],
        ['script-iife', injectScript],
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
