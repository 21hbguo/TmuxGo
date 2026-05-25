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
