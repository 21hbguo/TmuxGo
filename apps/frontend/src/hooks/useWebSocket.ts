'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from './usePreferences'
import { getWebSocketBase } from '@/lib/runtime-endpoints'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'
type WSState={ws:WebSocket|null,reconnectTimer:ReturnType<typeof setTimeout>|null,reconnectCount:number,isConnecting:boolean,socketReady:boolean,pingTimer:ReturnType<typeof setInterval>|null,pongTimer:ReturnType<typeof setTimeout>|null,closeTimer:ReturnType<typeof setTimeout>|null,backgroundCloseTimer:ReturnType<typeof setTimeout>|null,subscribers:number,lastPongAt:number,hiddenAt:number,backgroundClosed:boolean,onMessage:((data:any)=>void)|null,onOpen:(()=>void)|null,onClose:(()=>void)|null,onError:(()=>void)|null,closeExpected:boolean,lastInteractionRecoverAt:number,listenersReady:boolean,cleanupListeners:(()=>void)|null}
const wsState:WSState={ws:null,reconnectTimer:null,reconnectCount:0,isConnecting:false,socketReady:false,pingTimer:null,pongTimer:null,closeTimer:null,backgroundCloseTimer:null,subscribers:0,lastPongAt:0,hiddenAt:0,backgroundClosed:false,onMessage:null,onOpen:null,onClose:null,onError:null,closeExpected:false,lastInteractionRecoverAt:0,listenersReady:false,cleanupListeners:null}
type OutputMessage={data:string,sessionName?:string|null,hostId?:string|null,resync?:boolean}
const outputListeners=new Set<(message:OutputMessage)=>void>()
const BACKGROUND_CLOSE_DELAY_MS=12000
function recordMobileDebug(event:string,data?:Record<string,unknown>) {
  recordMobileDiagnostic(event,data,event.includes('close')||event.includes('error')||event.includes('background'))
  if (typeof window==='undefined'||!window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target=window as typeof window&{__tmuxgoMobileDebug?:{events:Array<Record<string,unknown>>}}
  const state=target.__tmuxgoMobileDebug||{events:[]}
  state.events.push({event,at:Math.round(performance.now()),...data})
  state.events=state.events.slice(-300)
  target.__tmuxgoMobileDebug=state
}
export function useWebSocket() {
  const reconnectCountRef=useRef(0)
  const updateConnection=useConsoleStore((s)=>s.updateConnection)
  const connectionStatus=useConsoleStore((s)=>s.connection.status)
  const isConnected=connectionStatus==='connected'
  const isSocketReady=wsState.socketReady||connectionStatus==='connected'||connectionStatus==='attaching'
  const {preferences}=usePreferences()
  const clearPongTimer=useCallback(()=>{
    if (!wsState.pongTimer) return
    clearTimeout(wsState.pongTimer)
    wsState.pongTimer=null
  },[])
  const clearBackgroundCloseTimer=useCallback(()=>{
    if (!wsState.backgroundCloseTimer) return
    clearTimeout(wsState.backgroundCloseTimer)
    wsState.backgroundCloseTimer=null
  },[])
  const handleMessage=useCallback((data:any)=>{
    switch (data.type) {
      case 'pong':
        wsState.lastPongAt=Date.now()
        clearPongTimer()
        updateConnection({latency:Date.now()-(data.timestamp||Date.now()),lastPing:new Date().toISOString()})
        break
      case 'output':
      case 'output_resync': {
        Array.from(outputListeners).forEach((listener)=>listener({data:data.data,sessionName:data.sessionName??null,hostId:data.hostId??null,resync:data.type==='output_resync'}))
        break
      }
      case 'connected':
        wsState.socketReady=true
        updateConnection({status:'attaching'})
        break
      case 'attached':
        window.dispatchEvent(new CustomEvent('tmux-attached',{detail:data}))
        updateConnection({status:'connected'})
        break
      case 'error':
        window.dispatchEvent(new CustomEvent('tmux-error',{detail:data}))
        updateConnection({status:'disconnected'})
        break
      case 'detached':
        window.dispatchEvent(new CustomEvent('tmux-detached',{detail:data}))
        break
      case 'session-exit':
        window.dispatchEvent(new CustomEvent('tmux-session-exit',{detail:data}))
        break
    }
  },[clearPongTimer,updateConnection])
  const sendPing=useCallback((timeout=8000)=>{
    const ws=wsState.ws
    if (!ws||ws.readyState!==WebSocket.OPEN) return
    ws.send(JSON.stringify({type:'ping',timestamp:Date.now()}))
    clearPongTimer()
    wsState.pongTimer=setTimeout(()=>{
      if (wsState.ws!==ws||ws.readyState!==WebSocket.OPEN) return
      wsState.closeExpected=false
      ws.close()
    },timeout)
  },[clearPongTimer])
  const connect=useCallback(()=>{
    if (typeof window==='undefined'||wsState.subscribers<=0) return
    if (document.visibilityState==='hidden') return
    const current=wsState.ws
    if (current&&(current.readyState===WebSocket.OPEN||current.readyState===WebSocket.CONNECTING||current.readyState===WebSocket.CLOSING)) return
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer)
      wsState.reconnectTimer=null
    }
    const wsUrl=getWebSocketBase()
    wsState.isConnecting=true
    recordMobileDebug('ws-connect')
    try {
      const ws=new WebSocket(wsUrl)
      wsState.ws=ws
      ws.onopen=()=>{
        if (wsState.ws!==ws) return
        wsState.isConnecting=false
        wsState.closeExpected=false
        wsState.backgroundClosed=false
        wsState.socketReady=true
        wsState.reconnectCount=0
        reconnectCountRef.current=0
        wsState.lastPongAt=Date.now()
        updateConnection({status:'attaching',latency:0})
        recordMobileDebug('ws-open')
        sendPing()
        window.dispatchEvent(new CustomEvent('ws-reconnected'))
        wsState.onOpen?.()
      }
      ws.onmessage=(event)=>{
        try {
          const data=JSON.parse(event.data)
          wsState.onMessage?.(data)
        } catch (err) {
          console.error('Failed to parse WebSocket message:',err)
        }
      }
      ws.onclose=()=>{
        if (wsState.ws===ws) {
          wsState.ws=null
        }
        wsState.isConnecting=false
        wsState.socketReady=false
        clearPongTimer()
        const expected=wsState.closeExpected
        wsState.closeExpected=false
        recordMobileDebug('ws-close',{expected,visibility:document.visibilityState})
        if (!expected&&document.visibilityState==='hidden') {
          wsState.hiddenAt=Date.now()
          wsState.backgroundClosed=true
          return
        }
        updateConnection({status:'disconnected'})
        if (!expected) {
          wsState.onClose?.()
        }
      }
      ws.onerror=()=>{
        if (wsState.ws===ws) {
          wsState.isConnecting=false
        }
        recordMobileDebug('ws-error',{visibility:document.visibilityState})
        wsState.onError?.()
      }
    } catch (err) {
      wsState.isConnecting=false
      recordMobileDebug('ws-connect-error')
      wsState.onError?.()
    }
  },[clearPongTimer,sendPing,updateConnection])
  const scheduleReconnect=useCallback(()=>{
    if (!preferences.autoReconnect||wsState.subscribers<=0) return
    if (typeof document!=='undefined'&&document.visibilityState==='hidden') {
      wsState.hiddenAt=Date.now()
      wsState.backgroundClosed=true
      return
    }
    if (wsState.reconnectTimer||wsState.isConnecting) return
    wsState.reconnectCount+=1
    reconnectCountRef.current=wsState.reconnectCount
    updateConnection({status:'reconnecting'})
    const baseDelay=wsState.reconnectCount===1?400:preferences.reconnectInterval
    const delay=Math.min(baseDelay*Math.max(wsState.reconnectCount,1),30000)
    wsState.reconnectTimer=setTimeout(()=>{
      wsState.reconnectTimer=null
      connect()
    },delay)
  },[connect,updateConnection,preferences.autoReconnect,preferences.reconnectInterval])
  const resetAndReconnect=useCallback(()=>{
    const ws=wsState.ws
    updateConnection({status:'reconnecting'})
    clearPongTimer()
    if (!ws) {
      connect()
      return
    }
    ws.onopen=null
    ws.onmessage=null
    ws.onerror=null
    ws.onclose=null
    try {
      ws.close()
    } catch {}
    wsState.ws=null
    wsState.isConnecting=false
    wsState.socketReady=false
    wsState.closeExpected=false
    wsState.reconnectCount=0
    reconnectCountRef.current=0
    connect()
  },[clearPongTimer,connect])
  const closeForBackgroundNow=useCallback(()=>{
    wsState.backgroundCloseTimer=null
    wsState.hiddenAt=Date.now()
    wsState.backgroundClosed=true
    clearPongTimer()
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer)
      wsState.reconnectTimer=null
    }
    const ws=wsState.ws
    recordMobileDebug('ws-background-close',{readyState:ws?.readyState??-1})
    if (!ws) return
    ws.onopen=null
    ws.onmessage=null
    ws.onerror=null
    ws.onclose=null
    try {
      ws.close()
    } catch {}
    wsState.ws=null
    wsState.isConnecting=false
    wsState.socketReady=false
    updateConnection({status:'disconnected'})
  },[clearPongTimer,updateConnection])
  const scheduleBackgroundClose=useCallback((source:string)=>{
    wsState.hiddenAt=Date.now()
    recordMobileDebug('ws-background-schedule',{source,visibility:document.visibilityState})
    if (wsState.backgroundCloseTimer) clearTimeout(wsState.backgroundCloseTimer)
    wsState.backgroundCloseTimer=setTimeout(()=>{
      if (document.visibilityState==='visible') {
        wsState.backgroundCloseTimer=null
        return
      }
      closeForBackgroundNow()
    },BACKGROUND_CLOSE_DELAY_MS)
  },[closeForBackgroundNow])
  const ensureConnection=useCallback((recover=false)=>{
    clearBackgroundCloseTimer()
    const ws=wsState.ws
    const resumed=wsState.backgroundClosed||wsState.hiddenAt>0&&Date.now()-wsState.hiddenAt>1200
    wsState.hiddenAt=0
    wsState.backgroundClosed=false
    recordMobileDebug('ws-ensure',{recover,resumed,readyState:ws?.readyState??-1})
    if (!ws) {
      wsState.reconnectCount=0
      connect()
      return
    }
    if (ws.readyState===WebSocket.OPEN) {
      const stale=Date.now()-wsState.lastPongAt>15000
      if (stale) {
        resetAndReconnect()
        return
      }
      if (recover||resumed) sendPing(3000)
      return
    }
    if (ws.readyState===WebSocket.CONNECTING||ws.readyState===WebSocket.CLOSING) return
    if (recover||ws.readyState===WebSocket.CLOSED) {
      wsState.reconnectCount=0
      connect()
    }
  },[clearBackgroundCloseTimer,connect,resetAndReconnect,sendPing])
  const send=useCallback((data:any)=>{
    if (wsState.ws?.readyState===WebSocket.OPEN) {
      wsState.ws.send(JSON.stringify(data))
      return true
    }
    return false
  },[])
  const subscribeOutput=useCallback((listener:(message:OutputMessage)=>void)=>{
    outputListeners.add(listener)
    return ()=>outputListeners.delete(listener)
  },[])
  useEffect(()=>{
    if (typeof window==='undefined') return
    if (wsState.closeTimer) {
      clearTimeout(wsState.closeTimer)
      wsState.closeTimer=null
    }
    wsState.subscribers+=1
    wsState.onMessage=handleMessage
    wsState.onOpen=()=>{}
    wsState.onClose=()=>{
      scheduleReconnect()
    }
    wsState.onError=()=>{
      scheduleReconnect()
    }
    connect()
    if (!wsState.pingTimer) {
      wsState.pingTimer=setInterval(()=>{
        if (document.visibilityState!=='visible') return
        const ws=wsState.ws
        if (!ws) {
          if (!wsState.isConnecting) {
            wsState.reconnectCount=0
            connect()
          }
          return
        }
        if (ws.readyState===WebSocket.OPEN) {
          if (Date.now()-wsState.lastPongAt>=10000) {
            sendPing()
          }
          return
        }
        if ((ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING)&&!wsState.isConnecting) {
          wsState.reconnectCount=0
          connect()
        }
      },1500)
    }
    const handleVisibilityChange=()=>{
      if (document.visibilityState==='hidden') {
        scheduleBackgroundClose('visibility')
        return
      }
      if (document.visibilityState==='visible') {
        ensureConnection(true)
      }
    }
    const handlePageHide=()=>{
      scheduleBackgroundClose('pagehide')
    }
    const handlePageShow=()=>{
      ensureConnection(false)
    }
    const handleFocus=()=>{
      ensureConnection(true)
    }
    const handleOnline=()=>{
      ensureConnection(true)
    }
    const handleInteractionRecover=()=>{
      if (document.visibilityState!=='visible') return
      const now=Date.now()
      if (now-wsState.lastInteractionRecoverAt<1200) return
      wsState.lastInteractionRecoverAt=now
      ensureConnection(true)
    }
    if (!wsState.listenersReady) {
      wsState.listenersReady=true
      document.addEventListener('visibilitychange',handleVisibilityChange)
      window.addEventListener('pagehide',handlePageHide)
      window.addEventListener('pageshow',handlePageShow)
      window.addEventListener('focus',handleFocus)
      window.addEventListener('online',handleOnline)
      document.addEventListener('pointerdown',handleInteractionRecover,true)
      document.addEventListener('touchstart',handleInteractionRecover,true)
      wsState.cleanupListeners=()=>{
        document.removeEventListener('visibilitychange',handleVisibilityChange)
        window.removeEventListener('pagehide',handlePageHide)
        window.removeEventListener('pageshow',handlePageShow)
        window.removeEventListener('focus',handleFocus)
        window.removeEventListener('online',handleOnline)
        document.removeEventListener('pointerdown',handleInteractionRecover,true)
        document.removeEventListener('touchstart',handleInteractionRecover,true)
      }
    }
    return ()=>{
      wsState.subscribers-=1
      if (wsState.subscribers<=0) {
        if (wsState.closeTimer) clearTimeout(wsState.closeTimer)
        wsState.closeTimer=setTimeout(()=>{
          if (wsState.subscribers>0) return
          wsState.closeTimer=null
          wsState.cleanupListeners?.()
          wsState.cleanupListeners=null
          wsState.listenersReady=false
          if (wsState.reconnectTimer) {
            clearTimeout(wsState.reconnectTimer)
            wsState.reconnectTimer=null
          }
          if (wsState.backgroundCloseTimer) {
            clearTimeout(wsState.backgroundCloseTimer)
            wsState.backgroundCloseTimer=null
          }
          if (wsState.pingTimer) {
            clearInterval(wsState.pingTimer)
            wsState.pingTimer=null
          }
          clearPongTimer()
          wsState.closeExpected=false
          if (wsState.ws) {
            wsState.closeExpected=true
            wsState.ws.close()
            wsState.ws=null
          }
          wsState.reconnectCount=0
          wsState.isConnecting=false
          wsState.socketReady=false
          wsState.lastPongAt=0
          wsState.hiddenAt=0
          wsState.backgroundClosed=false
          wsState.lastInteractionRecoverAt=0
          wsState.onMessage=null
          wsState.onOpen=null
          wsState.onClose=null
          wsState.onError=null
        },250)
      }
    }
  },[connect,ensureConnection,handleMessage,scheduleReconnect,sendPing,clearPongTimer,scheduleBackgroundClose])
  return {send,isConnected,isSocketReady,subscribeOutput}
}
