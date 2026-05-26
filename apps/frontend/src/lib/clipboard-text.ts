let storedClipboardText=''
export interface ClipboardReadResult {
  text:string
  source:'system'|'memory'|'empty'
  unavailable:boolean
}
export interface ClipboardWriteResult {
  copied:boolean
  source:'system'|'memory'
  unavailable:boolean
}
export function getStoredClipboardText() {
  return storedClipboardText
}
export function resetStoredClipboardText() {
  storedClipboardText=''
}
export async function readClipboardTextOnly():Promise<ClipboardReadResult> {
  try {
    if (navigator.clipboard?.readText) {
      const text=await navigator.clipboard.readText()
      if (text) {
        storedClipboardText=text
        return {text,source:'system',unavailable:false}
      }
      return {text:'',source:'empty',unavailable:false}
    }
  } catch {}
  if (storedClipboardText) return {text:storedClipboardText,source:'memory',unavailable:true}
  return {text:'',source:'empty',unavailable:true}
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

export async function writeClipboardText(text:string):Promise<ClipboardWriteResult> {
  storedClipboardText=text
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return {copied:true,source:'system',unavailable:false}
    }
  } catch {}
  if (typeof document.execCommand==='function') {
    const ta=document.createElement('textarea')
    ta.value=text
    ta.style.cssText='position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    const copied=document.execCommand('copy')
    document.body.removeChild(ta)
    if (copied) return {copied:true,source:'system',unavailable:false}
  }
  return {copied:!!text,source:'memory',unavailable:true}
}
