// Markdown 图片 src 归一化：把作者写进文档的路径翻译成「root 相对的仓库路径」。
// 这里只做纯字符串判断，不发请求、不碰 DOM——取图由 markdown-image-cache 负责，
// 渲染层（markdown.ts）只负责把这些结论写进 data-md-* 属性。
export interface MarkdownAssetContext {
  hostId: string
  rootId: string
  /** 当前 md 文件在 root 内的相对路径，如 `docs/readme.md` */
  filePath: string
}

/**
 * - relative: `./a.png` / `sub/a.png`
 * - root-absolute: `/abs/x.png`（按 root 相对理解；后端 normalizeRelativePath 会剥前导 `/`）
 * - external: `http(s):` 与协议相对 `//cdn/x.png`
 * - data: `data:image/*`
 * - invalid: 其它 scheme（`javascript:`/`file:`/`vbscript:` …）或空串
 */
export type MarkdownImageKind = 'relative' | 'root-absolute' | 'external' | 'data' | 'invalid'

export interface MarkdownImageRef {
  /** 可读形式：本地路径做 decodeURIComponent（`%E4%B8%AD` → `中`），远程/内联保持原样（解码会破坏 URL 语义） */
  src: string
  /** HTML 里实际出现的原始字符串；组件用它回查 DOM */
  rawSrc: string
  kind: MarkdownImageKind
  /** root 相对路径；external/data/invalid 恒为 null */
  resolvedPath: string | null
  reason?: 'outside-root' | 'missing-context' | 'unsafe-scheme'
}

// 协议必须在最前面判断：`data:` 也满足「有 scheme」，顺序颠倒会把 data 判成 invalid
const EXTERNAL_RE = /^(?:https?:)?\/\//i
const DATA_IMAGE_RE = /^data:image\//i
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const INDENTED_LIST_RE = /^[-*+]\s|^\d+[.)]\s/

export function classifyImageSrc(src: string): MarkdownImageKind {
  const value = (src || '').trim()
  if (!value) return 'invalid'
  if (EXTERNAL_RE.test(value)) return 'external'
  if (DATA_IMAGE_RE.test(value)) return 'data'
  // 「有 scheme 但不是 http(s)/data:image」一律拒绝，交给 DOMPurify 之前就挡掉
  if (SCHEME_RE.test(value)) return 'invalid'
  if (value.startsWith('/')) return 'root-absolute'
  return 'relative'
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法百分号序列：保持原样，让它以「找不到文件」的方式失败，而不是抛到渲染路径上
    return value
  }
}

function normalizeSlashes(value: string) {
  return value.replace(/\\/g, '/')
}

function dirnameOf(filePath: string) {
  const normalized = normalizeSlashes(filePath).replace(/^\/+/, '')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

// 词法归一化：`..` 弹栈，弹空即判定逃出 root。不做 realpath，符号链接沿用后端「按文件管理器语义跟随」的取舍
function joinInsideRoot(baseDir: string, target: string): string | null {
  const segments: string[] = []
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length ? segments.join('/') : null
}

export function resolveImageRef(src: string, ctx?: MarkdownAssetContext): MarkdownImageRef {
  const rawSrc = src || ''
  const kind = classifyImageSrc(rawSrc)
  const trimmed = rawSrc.trim()

  if (kind === 'external' || kind === 'data') {
    return { src: trimmed, rawSrc, kind, resolvedPath: null }
  }
  if (kind === 'invalid') {
    return { src: trimmed, rawSrc, kind, resolvedPath: null, reason: 'unsafe-scheme' }
  }
  const readable = decodeSafe(trimmed)
  if (!ctx) {
    return { src: readable, rawSrc, kind, resolvedPath: null, reason: 'missing-context' }
  }
  // root 相对从 root 根算，relative 从 md 文件所在目录算
  const baseDir = kind === 'relative' ? dirnameOf(ctx.filePath) : ''
  const target = normalizeSlashes(readable).replace(/^\/+/, '')
  const resolvedPath = joinInsideRoot(baseDir, target)
  if (!resolvedPath) {
    return { src: readable, rawSrc, kind, resolvedPath: null, reason: 'outside-root' }
  }
  return { src: readable, rawSrc, kind, resolvedPath }
}

/** 4 空格或 tab 开头的行；被 splitMarkdownSegments 用来识别缩进代码块 */
export function isIndentedCodeLine(line: string) {
  return /^(?: {4}|\t)/.test(line) && !INDENTED_LIST_RE.test(line.replace(/^(?: {4}|\t)+/, ''))
}
