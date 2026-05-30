'use client'
import { getApiBase } from './runtime-endpoints'

type DiagnosticEvent=Record<string, unknown>&{event:string}
type DiagnosticState={events:DiagnosticEvent[];sessionId:string}
const MAX_LOCAL_EVENTS=400
const MAX_BATCH_EVENTS=80
let buffer:DiagnosticEvent[]=[]
let flushTimer:ReturnType<typeof setTimeout>|null=null
let diagnosticsStarted=false
let sessionId=''

function isMobileRuntime() {
  if (typeof window==='undefined') return false
  try {
    if (window.localStorage.getItem('tmuxgo-debug-mobile')) return true
  } catch {}
  if (typeof window.matchMedia==='function'&&window.matchMedia('(pointer: coarse)').matches) return true
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}
function getSessionId() {
  if (sessionId) return sessionId
  sessionId=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
  return sessionId
}
function getMetrics() {
  const vv=window.visualViewport
  const terminal=document.querySelector('[data-terminal]') as HTMLElement|null
  const xterm=terminal?.querySelector('.xterm') as HTMLElement|null
  const termRect=terminal?.getBoundingClientRect()
  const xtermRect=xterm?.getBoundingClientRect()
  return {
    path: window.location.pathname,
    visibility: document.visibilityState,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    vvWidth: Math.round(vv?.width||0),
    vvHeight: Math.round(vv?.height||0),
    vvOffsetTop: Math.round(vv?.offsetTop||0),
    active: document.activeElement instanceof HTMLElement ? `${document.activeElement.tagName}.${String(document.activeElement.className||'').slice(0,80)}` : '',
    keyboardOpen: document.body.classList.contains('keyboard-open'),
    term: termRect ? { x: Math.round(termRect.x), y: Math.round(termRect.y), w: Math.round(termRect.width), h: Math.round(termRect.height) } : null,
    xterm: xtermRect ? { x: Math.round(xtermRect.x), y: Math.round(xtermRect.y), w: Math.round(xtermRect.width), h: Math.round(xtermRect.height) } : null,
  }
}
function expose(event:DiagnosticEvent) {
  const target=window as typeof window&{__tmuxgoMobileDiagnostics?:DiagnosticState}
  const state=target.__tmuxgoMobileDiagnostics||{events:[],sessionId:getSessionId()}
  state.events.push(event)
  state.events=state.events.slice(-MAX_LOCAL_EVENTS)
  target.__tmuxgoMobileDiagnostics=state
}
function scheduleFlush(delay=600) {
  if (flushTimer) return
  flushTimer=setTimeout(() => void flushMobileDiagnostics(), delay)
}
export function recordMobileDiagnostic(event:string,data?:Record<string, unknown>,urgent=false) {
  try {
    if (typeof window==='undefined'||!isMobileRuntime()) return
    const entry:DiagnosticEvent={event,at:Math.round(performance.now()),wallAt:Date.now(),sessionId:getSessionId(),...getMetrics(),...(data||{})}
    expose(entry)
    buffer.push(entry)
    if (buffer.length>=MAX_BATCH_EVENTS||urgent) {
      void flushMobileDiagnostics()
      return
    }
    scheduleFlush()
  } catch {
  }
}
export async function flushMobileDiagnostics() {
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
function rectChanged(a:DOMRectReadOnly|null,b:DOMRectReadOnly|null) {
  if (!a||!b) return !!a!==!!b
  return Math.abs(a.x-b.x)>1||Math.abs(a.y-b.y)>1||Math.abs(a.width-b.width)>1||Math.abs(a.height-b.height)>1
}
function rectData(rect:DOMRectReadOnly|null) {
  if (!rect) return null
  return {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}
}
function sameRectData(a:ReturnType<typeof rectData>|undefined,b:ReturnType<typeof rectData>|undefined) {
  if (!a||!b) return a===b
  return a.x===b.x&&a.y===b.y&&a.w===b.w&&a.h===b.h
}
export function startMobileFlickerDiagnostics() {
  if (typeof window==='undefined'||diagnosticsStarted||!isMobileRuntime()) return () => {}
  diagnosticsStarted=true
  let frame=0
  let sampleUntil=performance.now()+6000
  let lastFrameAt=performance.now()
  let lastTermRect:DOMRectReadOnly|null=null
  let lastMainRect:DOMRectReadOnly|null=null
  let lastSuspectAt=0
  let shiftTimes:number[]=[]
  let resizeObserver:ResizeObserver|null=null
  let observeTimer:ReturnType<typeof setInterval>|null=null
  let observedTerminal:Element|null=null
  let observedMain:Element|null=null
  const observedRects=new WeakMap<Element,ReturnType<typeof rectData>>()
  const arm=(reason:string,duration=6000) => {
    sampleUntil=Math.max(sampleUntil,performance.now()+duration)
    recordMobileDiagnostic('diag-arm',{reason})
    if (!frame) frame=requestAnimationFrame(sample)
  }
  const markShift=(source:string,now:number,data:Record<string,unknown>) => {
    shiftTimes=shiftTimes.filter((item)=>now-item<1400)
    shiftTimes.push(now)
    recordMobileDiagnostic('rect-shift',{source,count:shiftTimes.length,...data})
    if (shiftTimes.length>=5&&now-lastSuspectAt>1800) {
      lastSuspectAt=now
      recordMobileDiagnostic('flicker-suspect',{source,count:shiftTimes.length,...data},true)
    }
  }
  const sample=(now:number) => {
    frame=0
    const gap=now-lastFrameAt
    lastFrameAt=now
    if (gap>90) recordMobileDiagnostic('frame-jank',{gap:Math.round(gap)},gap>160)
    const term=document.querySelector('[data-terminal]') as HTMLElement|null
    const main=document.querySelector('main') as HTMLElement|null
    const termRect=term?.getBoundingClientRect()||null
    const mainRect=main?.getBoundingClientRect()||null
    if (rectChanged(lastTermRect,termRect)) markShift('terminal',now,{prev:rectData(lastTermRect),next:rectData(termRect)})
    if (rectChanged(lastMainRect,mainRect)) markShift('main',now,{prev:rectData(lastMainRect),next:rectData(mainRect)})
    lastTermRect=termRect
    lastMainRect=mainRect
    if (now<sampleUntil) frame=requestAnimationFrame(sample)
  }
  const observeTargets=() => {
    const terminal=document.querySelector('[data-terminal]')
    const main=document.querySelector('main')
    if (terminal===observedTerminal&&main===observedMain) return
    observedTerminal=terminal
    observedMain=main
    if (resizeObserver) resizeObserver.disconnect()
    if (typeof ResizeObserver==='undefined') return
    resizeObserver=new ResizeObserver((entries) => {
      let changed=false
      for (const entry of entries) {
        const next=rectData(entry.contentRect)
        const prev=observedRects.get(entry.target)
        if (sameRectData(prev,next)) continue
        observedRects.set(entry.target,next)
        changed=true
        recordMobileDiagnostic('resize-observed',{target:(entry.target as HTMLElement).dataset?.terminal!==undefined?'terminal':entry.target.tagName,rect:next})
      }
      if (changed) arm('resize-observer')
    })
    if (terminal) resizeObserver.observe(terminal)
    if (main) resizeObserver.observe(main)
  }
  const eventHandler=(event:Event) => {
    recordMobileDiagnostic(`dom-${event.type}`)
    arm(event.type)
    if (event.type==='pagehide'||event.type==='visibilitychange') void flushMobileDiagnostics()
  }
  const perfObservers:PerformanceObserver[]=[]
  try {
    const longTaskObserver=new PerformanceObserver((list)=> {
      for (const entry of list.getEntries()) recordMobileDiagnostic('longtask',{duration:Math.round(entry.duration),name:entry.name},entry.duration>120)
    })
    longTaskObserver.observe({entryTypes:['longtask']})
    perfObservers.push(longTaskObserver)
  } catch {}
  try {
    const shiftObserver=new PerformanceObserver((list)=> {
      for (const entry of list.getEntries() as any[]) {
        if (entry.hadRecentInput) continue
        recordMobileDiagnostic('layout-shift',{value:entry.value},entry.value>0.02)
      }
    })
    shiftObserver.observe({type:'layout-shift',buffered:true} as PerformanceObserverInit)
    perfObservers.push(shiftObserver)
  } catch {}
  for (const type of ['resize','focus','blur','pagehide','pageshow']) window.addEventListener(type,eventHandler,true)
  document.addEventListener('visibilitychange',eventHandler,true)
  document.addEventListener('touchstart',eventHandler,true)
  window.visualViewport?.addEventListener('resize',eventHandler,true)
  window.visualViewport?.addEventListener('scroll',eventHandler,true)
  observeTargets()
  observeTimer=setInterval(() => {
    if ((observedTerminal&&!observedTerminal.isConnected)||(observedMain&&!observedMain.isConnected)||!observedTerminal||!observedMain) observeTargets()
  },2000)
  arm('start',8000)
  return () => {
    diagnosticsStarted=false
    if (frame) cancelAnimationFrame(frame)
    if (observeTimer) clearInterval(observeTimer)
    resizeObserver?.disconnect()
    for (const observer of perfObservers) observer.disconnect()
    for (const type of ['resize','focus','blur','pagehide','pageshow']) window.removeEventListener(type,eventHandler,true)
    document.removeEventListener('visibilitychange',eventHandler,true)
    document.removeEventListener('touchstart',eventHandler,true)
    window.visualViewport?.removeEventListener('resize',eventHandler,true)
    window.visualViewport?.removeEventListener('scroll',eventHandler,true)
    void flushMobileDiagnostics()
  }
}
