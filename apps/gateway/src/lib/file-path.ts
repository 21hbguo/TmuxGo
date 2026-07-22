import path from 'path'

export function isDotPath(relativePath: string) {
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith('.') && part.length > 1)
}
export function normalizeRelativePath(relativePath = '') {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}
export function sanitizePathSegment(name: string) {
  const normalized = (name || '').replace(/\0/g, '').trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) throw new Error('Invalid name')
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
export function isLikelyBinary(buffer: Buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)
}
