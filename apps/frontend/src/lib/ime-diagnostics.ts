'use client'
import { getApiBase } from './runtime-endpoints'

type ImeDiagnosticEvent=Record<string,unknown>&{event:string;scope:string}
type ImeDiagnosticState={events:ImeDiagnosticEvent[];sessionId:string}
const MAX_LOCAL_EVENTS=500
const MAX_BATCH_EVENTS=100
let buffer:ImeDiagnosticEvent[]=[]
let flushTimer:ReturnType<typeof setTimeout>|null=null
let sessionId=''
let armedUntil=0

function isImeDebugEnabled() {
  if (typeof window==='undefined') return false
  try {
    return !!window.localStorage.getItem('tmuxgo-debug-ime')||Date.now()<armedUntil
  } catch {
    return Date.now()<armedUntil
  }
}
function getSessionId() {
  if (sessionId) return sessionId
  sessionId=`ime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
  return sessionId
}
function getMetrics() {
  const vv=window.visualViewport
  const terminal=document.querySelector('[data-terminal]') as HTMLElement|null
  const helper=terminal?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement|null
  return {
    path: window.location.pathname,
    visibility: document.visibilityState,
    active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${String(document.activeElement.className||'').slice(0,80)}` : '',
    helperValue: helper?.value || '',
    helperSelectionStart: helper?.selectionStart ?? null,
    helperSelectionEnd: helper?.selectionEnd ?? null,
    vvWidth: Math.round(vv?.width||0),
    vvHeight: Math.round(vv?.height||0),
  }
}
function expose(event:ImeDiagnosticEvent) {
  const target=window as typeof window&{__tmuxgoImeDebug?:ImeDiagnosticState}
  const state=target.__tmuxgoImeDebug||{events:[],sessionId:getSessionId()}
  state.events.push(event)
  state.events=state.events.slice(-MAX_LOCAL_EVENTS)
  target.__tmuxgoImeDebug=state
}
function scheduleFlush(delay=400) {
  if (flushTimer) return
  flushTimer=setTimeout(() => void flushImeDiagnostics(),delay)
}
export function armImeDiagnostics(reason:string,durationMs=20000) {
  if (typeof window==='undefined') return
  armedUntil=Math.max(armedUntil,Date.now()+durationMs)
  recordImeDiagnostic('ime-diagnostics','arm',{reason,durationMs,armedUntil},true)
}
export function recordImeDiagnostic(scope:string,event:string,data?:Record<string,unknown>,urgent=false) {
  try {
    if (typeof window==='undefined'||!isImeDebugEnabled()) return
    const entry:ImeDiagnosticEvent={scope,event,at:Math.round(performance.now()),wallAt:Date.now(),sessionId:getSessionId(),...getMetrics(),...(data||{})}
    expose(entry)
    buffer.push(entry)
    if (buffer.length>=MAX_BATCH_EVENTS||urgent) {
      void flushImeDiagnostics()
      return
    }
    scheduleFlush()
  } catch {
  }
}
export async function flushImeDiagnostics() {
  if (typeof window==='undefined'||buffer.length===0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer=null
  }
  const events=buffer.splice(0,MAX_BATCH_EVENTS)
  const body=JSON.stringify({sessionId:getSessionId(),events})
  const url=`${getApiBase()}/api/client-events`
  try {
    await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body,keepalive:true})
    return
  } catch {
  }
  try {
    if (navigator.sendBeacon&&navigator.sendBeacon(url,new Blob([body],{type:'application/json'}))) return
  } catch {}
  buffer=events.concat(buffer).slice(-MAX_LOCAL_EVENTS)
}
