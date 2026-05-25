export function quoteShellPath(path: string) {
  return `'${path.replace(/'/g, `'\\''`)}'`
}
export function decodeDroppedPath(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    if (trimmed.startsWith('file://')) return decodeURIComponent(new URL(trimmed).pathname)
    if (trimmed.startsWith('vscode-remote://')) {
      const url = new URL(trimmed)
      return decodeURIComponent(url.pathname)
    }
  } catch {}
  return trimmed
}
export function getDroppedPaths(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return []
  const paths: string[] = []
  const uriList = dataTransfer.getData('text/uri-list')
  const text = dataTransfer.getData('text/plain')
  for (const file of Array.from(dataTransfer.files || [])) {
    if (file.webkitRelativePath) paths.push(file.webkitRelativePath)
    else if (file.name) paths.push(file.name)
  }
  for (const item of [...uriList.split(/\r?\n/), ...text.split(/\r?\n/)].map(decodeDroppedPath)) {
    if (item && !item.startsWith('#')) paths.push(item)
  }
  return Array.from(new Set(paths))
}
export function formatDroppedPaths(dataTransfer: DataTransfer | null) {
  const paths = getDroppedPaths(dataTransfer)
  return paths.map(quoteShellPath).join(' ')
}
