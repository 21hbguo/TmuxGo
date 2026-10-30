export type PreviewKind = 'markdown' | 'html' | 'csv' | 'pdf' | 'image' | 'audio' | 'video' | 'svg' | 'text' | 'binary'

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx'])
const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])
const CSV_EXT = new Set(['.csv', '.tsv', '.tab'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff'])
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.flac', '.opus'])
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov'])
const TEXT_EXT = new Set([
  '.txt',
  '.log',
  '.json',
  '.jsonc',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.toml',
  '.sh',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.css',
  '.map',
])

function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** 只按扩展名归类，不做内容嗅探：拿不到字节时也要能决定用哪个预览器 */
export function previewKindForPath(path: string): PreviewKind {
  const ext = extensionOf(path)
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  if (CSV_EXT.has(ext)) return 'csv'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.svg') return 'svg'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}

export function isPreviewableKind(kind: PreviewKind): boolean {
  return kind !== 'binary'
}

/**
 * 能否走 /files/raw 内联流：svg 必须排除（后端 415，且 inline svg 会在应用源执行脚本），
 * markdown/csv 由前端解析器渲染，不需要 raw。
 */
export function rawPreviewSupported(kind: PreviewKind): boolean {
  return (
    kind === 'pdf' || kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'html' || kind === 'text'
  )
}

/** svg 只做源码预览（text 编辑器），不能当图片塞进 <img> */
export function sourcePreviewKind(path: string): 'svg' | 'text' | null {
  return extensionOf(path) === '.svg' ? 'svg' : null
}
