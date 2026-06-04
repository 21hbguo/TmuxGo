const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
}
function pad(value: number) {
  return String(value).padStart(2, '0')
}
function timestamp(date = new Date()) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}
function extensionFor(type: string) {
  return IMAGE_EXTENSIONS[type.toLowerCase()] || 'png'
}
function nameFor(file: File, index: number, date = new Date()) {
  const suffix = index ? `-${index + 1}` : ''
  return `pasted-${timestamp(date)}${suffix}.${extensionFor(file.type)}`
}
function imageFilesFromItems(items: DataTransferItemList | undefined | null) {
  if (!items) return []
  return Array.from(items).flatMap((item) => {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}
function imageFilesFromList(files: FileList | undefined | null) {
  if (!files) return []
  return Array.from(files).filter((file) => file.type.toLowerCase().startsWith('image/'))
}
export function extractClipboardImageFiles(data: DataTransfer | null | undefined) {
  const files = imageFilesFromItems(data?.items)
  const source = files.length ? files : imageFilesFromList(data?.files)
  const now = new Date()
  return source.map((file, index) => new File([file], nameFor(file, index, now), { type: file.type, lastModified: Date.now() }))
}
