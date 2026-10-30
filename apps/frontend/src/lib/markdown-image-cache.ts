import { api, fetchApiBlob } from './api'
import { resolveImageRef, type MarkdownAssetContext } from './markdown-assets'

export interface MarkdownImageLoader {
  /** 本地图返回 objectURL，远程/内联原样返回 src；解析失败或取图失败返回 null（由调用方渲染占位） */
  load(src: string): Promise<string | null>
  /** 已知 root 相对路径时直接取图（live preview 的图片 widget 用，避免二次相对解析） */
  loadResolved(rootPath: string): Promise<string | null>
  dispose(): void
}

interface MarkdownImageLoaderDeps {
  /** 默认 fetchApiBlob：/api 的 Bearer 由它带，refreshed 后自带一次重试 */
  fetchImage?: (apiPath: string) => Promise<Blob>
  createObjectUrl?: (blob: Blob) => string
  revokeObjectUrl?: (url: string) => void
}

// 并发上限 3：远端 host 走 SSH 取图，一次预览几十张图同时打过去会把 SSH 通道挤满
const MAX_CONCURRENT = 3

export function createMarkdownImageLoader(
  ctx: MarkdownAssetContext,
  deps: MarkdownImageLoaderDeps = {},
): MarkdownImageLoader {
  const fetchImage = deps.fetchImage ?? ((path: string) => fetchApiBlob(path))
  const createObjectUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revokeObjectUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url))
  // 同一 src 只取一次：缓存的是 Promise 而不是结果，并发调用共享同一趟请求
  const pending = new Map<string, Promise<string | null>>()
  const objectUrls = new Set<string>()
  const queue: (() => void)[] = []
  let active = 0
  let disposed = false

  const releaseSlot = () => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }
  const withSlot = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        if (disposed) {
          resolve(null as unknown as T)
          return
        }
        active += 1
        task().then(resolve, reject).finally(releaseSlot)
      }
      if (active < MAX_CONCURRENT) start()
      else queue.push(start)
    })

  const loadLocal = async (resolvedPath: string) => {
    const blob = await fetchImage(api.files.imageUrl(ctx.hostId, ctx.rootId, resolvedPath))
    // 请求回来时组件可能已卸载：不再创建 objectURL，避免没人 revoke 的泄漏
    if (disposed) return null
    const url = createObjectUrl(blob)
    objectUrls.add(url)
    return url
  }

  return {
    load(src: string) {
      if (disposed) return Promise.resolve(null)
      const ref = resolveImageRef(src, ctx)
      if (ref.kind === 'external' || ref.kind === 'data') return Promise.resolve(ref.src)
      if (!ref.resolvedPath) return Promise.resolve(null)
      const cached = pending.get(src)
      if (cached) return cached
      const task = withSlot(() => loadLocal(ref.resolvedPath!)).catch(() => null)
      pending.set(src, task)
      return task
    },
    loadResolved(rootPath: string) {
      if (disposed) return Promise.resolve(null)
      const normalized = rootPath.replace(/^\/+/, '')
      if (!normalized || normalized.split('/').includes('..')) return Promise.resolve(null)
      const key = `resolved:${normalized}`
      const cached = pending.get(key)
      if (cached) return cached
      const task = withSlot(() => loadLocal(normalized)).catch(() => null)
      pending.set(key, task)
      return task
    },
    dispose() {
      disposed = true
      queue.length = 0
      pending.clear()
      for (const url of objectUrls) revokeObjectUrl(url)
      objectUrls.clear()
    },
  }
}
