export async function readClipboardTextOnly() {
  if (navigator.clipboard?.readText) {
    const text = await navigator.clipboard.readText()
    if (text) return text
  }
  if (!navigator.clipboard?.read) return ''
  const items = await navigator.clipboard.read()
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue
    const blob = await item.getType('text/plain')
    const text = await blob.text()
    if (text) return text
  }
  for (const item of items) {
    if (!item.types.includes('text/html')) continue
    const blob = await item.getType('text/html')
    const html = await blob.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const text = doc.body.textContent || ''
    if (text) return text
  }
  return ''
}

export function extractClipboardText(data?: DataTransfer | null) {
  if (!data) return ''
  const text = data.getData('text/plain')
  if (text) return text
  const html = data.getData('text/html')
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.textContent || ''
}

export async function writeClipboardText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(ta)
  return copied
}
