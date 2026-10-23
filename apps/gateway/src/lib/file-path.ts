import path from 'path'

export function isDotPath(relativePath: string) {
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith('.') && part.length > 1)
}
export function normalizeRelativePath(relativePath = '') {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}
export function sanitizePathSegment(name: string) {
  const normalized = (name || '').replace(/\0/g, '').trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized))
    throw new Error('Invalid name')
  return normalized
}
export function isPathInside(rootPath: string, targetPath: string) {
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
  return targetPath === rootPath || targetPath.startsWith(prefix)
}
export function getBreadcrumbs(relativePath: string) {
  const parts = relativePath ? relativePath.split(/[\\/]+/).filter(Boolean) : []
  return [{ name: '/', path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))]
}
// 全量扫描，不再只看头部 4096 字节：这个判定同时服务 preview（只读展示）与
// save（按 utf8 覆盖写回）。头部采样对「NUL 落在 4K 之后」的二进制（tar/zip/
// 压缩产物常见）会误判成文本，save 一旦放行就是不可逆的数据丢失。
// 三个调用点（file-ops 的预览、读全文、保存，以及 file-search 的内容搜索）都是
// 先 readFile 拿到整块 buffer 且受 LARGE_FILE_LIMIT=512KiB 约束，全量 includes(0)
// 是 memchr，不新增 IO，也不拖慢预览；真正的大文件在更早的分支就被 large-file 拦掉。
export function isLikelyBinary(buffer: Buffer) {
  return buffer.includes(0)
}
