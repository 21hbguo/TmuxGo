// 上传链路共享的文件元信息展示与限额（对齐 gateway @fastify/multipart 注册参数，
// 超限前端先拦一次给出清晰文案，服务端仍是权威）
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024
export const MAX_UPLOAD_FILES = 20

export function formatFileSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}

// 行内标出扩展名与 MIME；浏览器报不出类型时落 octet-stream，
// 未知类型不阻止上传（预览/下载分离由服务端与预览层负责）
export function fileTypeLabel(file: File, unknownLabel: string) {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : ''
  const mime = file.type || 'application/octet-stream'
  return ext ? `${ext} · ${mime}` : `${mime} · ${unknownLabel}`
}
