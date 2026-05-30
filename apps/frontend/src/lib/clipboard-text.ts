let storedClipboardText=''
export interface ClipboardWriteOptions {
}
export type ClipboardWriteReason='ok'|'permission_denied'|'api_unavailable'|'sync_copy_failed'
export interface ClipboardReadResult {
  text:string
  source:'system'|'memory'|'empty'
  unavailable:boolean
}
export interface ClipboardWriteResult {
  copied:boolean
  source:'system'|'memory'
  unavailable:boolean
  reason:ClipboardWriteReason
}
export interface ClipboardVerifyResult {
  allowed:boolean
  matches:boolean
  text:string
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

function writeClipboardTextSync(text:string) {
  if (typeof document.execCommand!=='function') return false
  const ta=document.createElement('textarea')
  ta.value=text
  ta.style.cssText='position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  const copied=document.execCommand('copy')
  document.body.removeChild(ta)
  return copied
}
function isPermissionDeniedError(error:unknown) {
  if (!error||typeof error!=='object') return false
  const name=(error as { name?:string }).name
  return name==='NotAllowedError'||name==='SecurityError'
}
export async function writeClipboardText(text:string,options:ClipboardWriteOptions={}):Promise<ClipboardWriteResult> {
  storedClipboardText=text
  let permissionDenied=false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return {copied:true,source:'system',unavailable:false,reason:'ok'}
    }
  } catch (error) {
    permissionDenied=isPermissionDeniedError(error)
  }
  if (writeClipboardTextSync(text)) return {copied:true,source:'system',unavailable:false,reason:'ok'}
  if (permissionDenied) return {copied:!!text,source:'memory',unavailable:true,reason:'permission_denied'}
  return {copied:!!text,source:'memory',unavailable:true,reason:'api_unavailable'}
}
export async function verifyClipboardText(text:string):Promise<ClipboardVerifyResult> {
  try {
    if (!navigator.clipboard?.readText) return {allowed:false,matches:false,text:''}
    const current=await navigator.clipboard.readText()
    return {allowed:true,matches:current===text,text:current}
  } catch {
    return {allowed:false,matches:false,text:''}
  }
}
