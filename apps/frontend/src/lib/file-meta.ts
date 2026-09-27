import type { IconType } from 'react-icons'
import { FiArchive, FiCode, FiFile, FiFileText, FiFilm, FiHeadphones, FiImage } from 'react-icons/fi'

// 上传链路共享的文件元信息展示与限额（对齐 gateway @fastify/multipart 注册参数，
// 超限前端先拦一次给出清晰文案，服务端仍是权威）
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024
export const MAX_UPLOAD_FILES = 20

export function formatFileSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}

// 文件类别仅作展示分组（图标/汇总 chips），不参与安全校验——
// 上传仍不限类型，服务端与预览层各自负责准入
export type FileCategory = 'image' | 'video' | 'audio' | 'archive' | 'document' | 'code' | 'text' | 'other'

// 扩展名优先（浏览器对无类型文件常报空 MIME），MIME 兜底给无扩展名文件分类
const CATEGORY_BY_EXT: Record<string, FileCategory> = {
  '.avif': 'image',
  '.bmp': 'image',
  '.gif': 'image',
  '.ico': 'image',
  '.jpeg': 'image',
  '.jpg': 'image',
  '.png': 'image',
  '.svg': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.webp': 'image',
  '.heic': 'image',
  '.heif': 'image',
  '.mp4': 'video',
  '.mkv': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.avi': 'video',
  '.m4v': 'video',
  '.flv': 'video',
  '.wmv': 'video',
  '.3gp': 'video',
  '.m2ts': 'video',
  '.mpg': 'video',
  '.mpeg': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.opus': 'audio',
  '.wma': 'audio',
  '.aiff': 'audio',
  '.mid': 'audio',
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.tgz': 'archive',
  '.bz2': 'archive',
  '.xz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.zst': 'archive',
  '.lz4': 'archive',
  '.jar': 'archive',
  '.war': 'archive',
  '.pdf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.xls': 'document',
  '.xlsx': 'document',
  '.ppt': 'document',
  '.pptx': 'document',
  '.odt': 'document',
  '.ods': 'document',
  '.odp': 'document',
  '.csv': 'document',
  '.tsv': 'document',
  '.rtf': 'document',
  '.epub': 'document',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.c': 'code',
  '.cc': 'code',
  '.cpp': 'code',
  '.h': 'code',
  '.hpp': 'code',
  '.cs': 'code',
  '.rb': 'code',
  '.php': 'code',
  '.swift': 'code',
  '.kt': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.fish': 'code',
  '.json': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.xml': 'code',
  '.html': 'code',
  '.htm': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.less': 'code',
  '.sql': 'code',
  '.lua': 'code',
  '.vue': 'code',
  '.svelte': 'code',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.log': 'text',
  '.ini': 'text',
  '.conf': 'text',
  '.env': 'text',
}

export function fileCategory(file: { name: string; type?: string }): FileCategory {
  const ext = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : ''
  const byExt = CATEGORY_BY_EXT[ext]
  if (byExt) return byExt
  const mime = file.type || ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (/^(application\/(zip|x-tar|gzip|x-bzip2|x-xz|x-7z-compressed|x-rar-compressed|zstd))$/.test(mime))
    return 'archive'
  if (mime.startsWith('text/')) return 'text'
  return 'other'
}

// 按出现顺序汇总类别计数，供头部 chips 展示
export function summarizeCategories(files: { name: string; type?: string }[]): [FileCategory, number][] {
  const counts = new Map<FileCategory, number>()
  for (const file of files) {
    const category = fileCategory(file)
    counts.set(category, (counts.get(category) || 0) + 1)
  }
  return [...counts.entries()]
}

export const CATEGORY_ICON: Record<FileCategory, IconType> = {
  image: FiImage,
  video: FiFilm,
  audio: FiHeadphones,
  archive: FiArchive,
  document: FiFileText,
  code: FiCode,
  text: FiFileText,
  other: FiFile,
}

// 行内标出扩展名与 MIME；浏览器报不出类型时落 octet-stream，
// 未知类型不阻止上传（预览/下载分离由服务端与预览层负责）
export function fileTypeLabel(file: File, unknownLabel: string) {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : ''
  const mime = file.type || 'application/octet-stream'
  return ext ? `${ext} · ${mime}` : `${mime} · ${unknownLabel}`
}
