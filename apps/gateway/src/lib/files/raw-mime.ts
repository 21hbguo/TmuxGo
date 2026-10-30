import path from 'path'

// raw 流的内联白名单：只列浏览器能安全内联展示的类型。
// svg 故意排除（image/svg+xml inline 会在应用源执行脚本），需要它时走 /files/content 源码预览。
export const RAW_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
}

// 浏览器内联 PDF 的体积闸门（前端 PdfPreview 也有一份，两份都只作提示，不阻断下载）
export const RAW_MAX_INLINE_BYTES = 64 * 1024 * 1024

const HTML_MIMES = new Set(['text/html; charset=utf-8', 'application/xhtml+xml; charset=utf-8'])

export function isHtmlMime(mime: string | null): boolean {
  return mime !== null && HTML_MIMES.has(mime)
}

/**
 * 扩展名 → MIME。未知扩展名在 download=true 时降级为 octet-stream（浏览器只会落盘），
 * 其余情况返回 null 由路由回 415；svg 任何情况下都不放行。
 */
export function resolveRawMime(absolutePath: string, download: boolean): string | null {
  const ext = path.extname(absolutePath).toLowerCase()
  if (ext === '.svg' || ext === '.svgz') return null
  const known = RAW_MIME_BY_EXT[ext]
  if (known) return known
  return download ? 'application/octet-stream' : null
}
