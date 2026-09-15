import type { FileRoot } from '@/types'
import { stripWrappedQuotes } from './terminal-links'
export function normalizeAbsolutePath(value: string) {
  const raw = stripWrappedQuotes(value.trim())
  if (!raw) return ''
  const stack: string[] = []
  if (!raw.startsWith('/')) return ''
  const base = raw
  for (const part of base.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}
export function getRootRelativePath(rootPath: string, absolutePath: string) {
  const normalizedRoot = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '')
  const normalizedPath = absolutePath.replace(/\/+$/, '')
  if (normalizedRoot !== '/' && normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`))
    return null
  return normalizedRoot === '/'
    ? normalizedPath.replace(/^\/+/, '')
    : normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '')
}
export function chooseFileRoot(roots: FileRoot[], absolutePath: string) {
  let match: FileRoot | null = null
  let matchLength = -1
  for (const root of roots) {
    const relativePath = getRootRelativePath(root.path, absolutePath)
    if (relativePath == null) continue
    if (root.path.length > matchLength) {
      match = root
      matchLength = root.path.length
    }
  }
  return match
}
function resolveHomePath(path: string, cwd: string, roots: FileRoot[]) {
  if (!path.startsWith('~/')) return ''
  const cwdHome = cwd.match(/^((?:\/home|\/Users)\/[^/]+)(?:\/|$)/)?.[1] || ''
  if (cwdHome) return normalizeAbsolutePath(`${cwdHome}/${path.slice(2)}`)
  const homeRoot =
    roots.find((item) => /home/i.test(item.label)) ||
    roots.find((item) => /^(?:\/home|\/Users)\/[^/]+$/.test(item.path)) ||
    null
  if (!homeRoot) return ''
  return normalizeAbsolutePath(`${homeRoot.path}/${path.slice(2)}`)
}
export function resolveCandidateAbsolutePaths(path: string, cwd: string, roots: FileRoot[]) {
  const candidates: string[] = []
  const push = (value: string) => {
    const normalized = normalizeAbsolutePath(value)
    if (normalized) candidates.push(normalized)
  }
  if (path.startsWith('/')) push(path)
  else if (path.startsWith('~/')) {
    const homePath = resolveHomePath(path, cwd, roots)
    if (homePath) push(homePath)
  } else if (path.startsWith('./') || path.startsWith('../')) {
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
  } else if (path.includes('/')) {
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
  } else {
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
  }
  return Array.from(new Set(candidates))
}
