'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from './usePreferences'
import { getWebSocketBase } from '@/lib/runtime-endpoints'
import { getWebSocketUrl, isAuthEnabled } from '@/lib/auth'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'
import { decodeStreamOutputBinary } from '@/lib/stream-binary'
import { decodeCellDiff, decodeCellSnapshot } from '@/lib/terminal-grid/decode-cell'
import { diffToAnsi, snapshotToAnsi } from '@/lib/terminal-grid/apply-cell'
type WSState={ws:WebSocket|null,reconnectTimer:ReturnType<typeof setTimeout>|null,reconnectCount:number,isConnecting:boolean,socketReady:boolean,attached:boolean,pingTimer:ReturnType<typeof setInterval>|null,pongTimer:ReturnType<typeof setTimeout>|null,connectTimer:ReturnType<typeof setTimeout>|null,connectAttempt:number,connectStartedAt:number,recoveryTimer:ReturnType<typeof setTimeout>|null,closeTimer:ReturnType<typeof setTimeout>|null,backgroundCloseTimer:ReturnType<typeof setTimeout>|null,subscribers:number,lastPongAt:number,hiddenAt:number,backgroundClosed:boolean,onMessage:((data:any)=>void)|null,onOpen:(()=>void)|null,onClose:(()=>void)|null,onError:(()=>void)|null,closeExpected:boolean,lastInteractionRecoverAt:number,listenersReady:boolean,cleanupListeners:(()=>void)|null}
const wsState:WSState={ws:null,reconnectTimer:null,reconnectCount:0,isConnecting:false,socketReady:false,attached:false,pingTimer:null,pongTimer:null,connectTimer:null,connectAttempt:0,connectStartedAt:0,recoveryTimer:null,closeTimer:null,backgroundCloseTimer:null,subscribers:0,lastPongAt:0,hiddenAt:0,backgroundClosed:false,onMessage:null,onOpen:null,onClose:null,onError:null,closeExpected:false,lastInteractionRecoverAt:0,listenersReady:false,cleanupListeners:null}
type OutputMessage={data:string,sessionName?:string|null,hostId?:string|null,resync?:boolean}
const outputListeners=new Map<string,Set<(message:OutputMessage)=>void>>()
let cellLastSeq=0
const BACKGROUND_CLOSE_DELAY_MS=12000
const CONNECT_TIMEOUT_MS=10000
const STALE_CONNECT_RESET_MS=8000
const RECOVERY_RELOAD_DELAY_MS=5000
const RECOVERY_RELOAD_COOLDOWN_MS=60000
const RECOVERY_RELOAD_KEY='tmuxgo-reconnect-reload-at'
function getOutputListenerKey(hostId:string,sessionName:string) {
  return `${hostId}\u0000${sessionName}`
}
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
  const clearConnectTimer=useCallback(()=>{
    if (!wsState.connectTimer) return
    clearTimeout(wsState.connectTimer)
    wsState.connectTimer=null
  },[])
  const clearRecoveryTimer=useCallback(()=>{
    if (!wsState.recoveryTimer) return
    clearTimeout(wsState.recoveryTimer)
    wsState.recoveryTimer=null
  },[])
  const armRecoveryReload=useCallback(()=>{
    if (wsState.recoveryTimer) return
    wsState.recoveryTimer=setTimeout(()=>{
      wsState.recoveryTimer=null
      if (document.visibilityState!=='visible'||wsState.socketReady||wsState.attached) return
      const previous=Number(window.sessionStorage.getItem(RECOVERY_RELOAD_KEY)||0)
      if (Number.isFinite(previous)&&Date.now()-previous<RECOVERY_RELOAD_COOLDOWN_MS) return
      window.sessionStorage.setItem(RECOVERY_RELOAD_KEY,String(Date.now()))
      recordMobileDebug('ws-recovery-reload')
      window.location.reload()
    },RECOVERY_RELOAD_DELAY_MS)
  },[])
  const clearBackgroundCloseTimer=useCallback(()=>{
    if (!wsState.backgroundCloseTimer) return
    clearTimeout(wsState.backgroundCloseTimer)
    wsState.backgroundCloseTimer=null
  },[])
  const emitOutput=useCallback((message:OutputMessage)=>{
    outputListeners.get(getOutputListenerKey(message.hostId||'local',message.sessionName||''))?.forEach((listener)=>listener(message))
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
        emitOutput({data:data.data,sessionName:data.sessionName??null,hostId:data.hostId??null,resync:data.type==='output_resync'})
        break
      }
      case 'stream_caps':
        break
      case 'connected':
        wsState.socketReady=true
        wsState.attached=false
        updateConnection({status:'attaching'})
        break
      case 'attached':
        wsState.attached=true
        clearRecoveryTimer()
        window.dispatchEvent(new CustomEvent('tmux-attached',{detail:data}))
        updateConnection({status:'connected'})
        break
      case 'resized':
        window.dispatchEvent(new CustomEvent('tmux-resized',{detail:data}))
        break
      case 'error':
        wsState.attached=false
        clearRecoveryTimer()
        window.dispatchEvent(new CustomEvent('tmux-error',{detail:data}))
        updateConnection({status:'disconnected'})
        break
      case 'detached':
        window.dispatchEvent(new CustomEvent('tmux-detached',{detail:data}))
        break
      case 'session-exit':
        window.dispatchEvent(new CustomEvent('tmux-session-exit',{detail:data}))
        break
      case 'agent_status_changed':
        window.dispatchEvent(new CustomEvent('tmuxgo-agent-status',{detail:data}))
        break
      case 'agent_status_snapshot':
        window.dispatchEvent(new CustomEvent('tmuxgo-agent-status-snapshot',{detail:data}))
        break
      case 'agent_status_removed':
        window.dispatchEvent(new CustomEvent('tmuxgo-agent-status-removed',{detail:data}))
        break
      case 'agent_notification':
        window.dispatchEvent(new CustomEvent('tmuxgo-agent-notification',{detail:data}))
        break
      case 'agent_monitor_error':
        window.dispatchEvent(new CustomEvent('tmuxgo-agent-monitor-error',{detail:data}))
        break
    }
  },[clearPongTimer,clearRecoveryTimer,emitOutput,updateConnection])
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
    if (current?.readyState===WebSocket.OPEN) return
    if (wsState.isConnecting) return
    if (current) {
      current.onopen=null
      current.onmessage=null
      current.onerror=null
      current.onclose=null
      try { current.close() } catch {}
      wsState.ws=null
      wsState.socketReady=false
      clearPongTimer()
    }
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer)
      wsState.reconnectTimer=null
    }
    wsState.isConnecting=true
    wsState.attached=false
    wsState.connectStartedAt=Date.now()
    const attempt=++wsState.connectAttempt
    clearConnectTimer()
    wsState.connectTimer=setTimeout(()=>{
      if (attempt!==wsState.connectAttempt||!wsState.isConnecting) return
      const ws=wsState.ws
      if (ws) {
        ws.onopen=null
        ws.onmessage=null
        ws.onerror=null
        ws.onclose=null
        try { ws.close() } catch {}
      }
      wsState.ws=null
      wsState.isConnecting=false
      wsState.socketReady=false
      wsState.attached=false
      wsState.connectTimer=null
      recordMobileDebug('ws-connect-timeout')
      updateConnection({status:'disconnected'})
      wsState.onClose?.()
    },CONNECT_TIMEOUT_MS)
    recordMobileDebug('ws-connect')
    const openSocket=(wsUrl:string)=>{
      if (attempt!==wsState.connectAttempt||!wsState.isConnecting) return
      try {
      const ws=new WebSocket(wsUrl)
      wsState.ws=ws
      ws.binaryType='arraybuffer'
      ws.onopen=()=>{
        if (wsState.ws!==ws) return
        clearConnectTimer()
        wsState.isConnecting=false
        wsState.closeExpected=false
        wsState.backgroundClosed=false
        wsState.socketReady=true
        wsState.attached=false
        wsState.reconnectCount=0
        reconnectCountRef.current=0
        wsState.lastPongAt=Date.now()
        updateConnection({status:'attaching',latency:0})
        recordMobileDebug('ws-open')
        try { ws.send(JSON.stringify({type:'stream_caps',binaryOutput:true,compressOutput:'gzip',cellOutput:false})) } catch {}
        sendPing()
        window.dispatchEvent(new CustomEvent('ws-reconnected'))
        wsState.onOpen?.()
      }
      ws.onmessage=(event)=>{
        try {
          if (typeof ArrayBuffer!=='undefined'&&event.data instanceof ArrayBuffer) {
            const decoded=decodeStreamOutputBinary(event.data)
            if (!decoded) return
            if (decoded.type==='cell_snapshot'&&decoded.cellPayload) {
              const snap=decodeCellSnapshot(decoded.cellPayload)
              if (!snap) {
                try { ws.send(JSON.stringify({type:'cell_resync_request',sessionName:decoded.sessionName,hostId:decoded.hostId})) } catch {}
                return
              }
              cellLastSeq=snap.seq
              const ansi=snapshotToAnsi(snap)
              wsState.onMessage?.({type:'output_resync',data:ansi,sessionName:decoded.sessionName,hostId:decoded.hostId})
              return
            }
            if (decoded.type==='cell_diff'&&decoded.cellPayload) {
              const diff=decodeCellDiff(decoded.cellPayload)
              if (!diff) return
              if (cellLastSeq!==0&&diff.baseSeq!==cellLastSeq) {
                try { ws.send(JSON.stringify({type:'cell_resync_request',sessionName:decoded.sessionName,hostId:decoded.hostId})) } catch {}
                return
              }
              cellLastSeq=diff.seq
              const ansi=diffToAnsi(diff)
              wsState.onMessage?.({type:'output',data:ansi,sessionName:decoded.sessionName,hostId:decoded.hostId})
              return
            }
            wsState.onMessage?.({type:decoded.type,data:decoded.data,sessionName:decoded.sessionName,hostId:decoded.hostId})
            return
          }
          const raw=typeof event.data==='string'?event.data:String(event.data)
          const data=JSON.parse(raw)
          wsState.onMessage?.(data)
        } catch (err) {
          console.error('Failed to parse WebSocket message:',err)
        }
      }
      ws.onclose=()=>{
        if (wsState.ws!==ws) return
        wsState.ws=null
        wsState.isConnecting=false
        wsState.socketReady=false
        wsState.attached=false
        clearConnectTimer()
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
        if (wsState.ws!==ws) return
        wsState.isConnecting=false
        wsState.socketReady=false
        wsState.attached=false
        clearConnectTimer()
        clearPongTimer()
        ws.onopen=null
        ws.onmessage=null
        ws.onerror=null
        ws.onclose=null
        try { ws.close() } catch {}
        wsState.ws=null
        recordMobileDebug('ws-error',{visibility:document.visibilityState})
        wsState.onError?.()
      }
      } catch (err) {
        clearConnectTimer()
        clearPongTimer()
        wsState.isConnecting=false
        wsState.socketReady=false
        wsState.attached=false
        wsState.ws=null
        recordMobileDebug('ws-connect-error')
        wsState.onError?.()
      }
    }
    if (isAuthEnabled()) {
      void getWebSocketUrl().then((wsUrl)=>{
        if (attempt!==wsState.connectAttempt||wsState.subscribers<=0||wsState.ws||!wsState.isConnecting) return
        openSocket(wsUrl)
      }).catch(()=>{
        if (attempt!==wsState.connectAttempt) return
        clearConnectTimer()
        clearPongTimer()
        wsState.isConnecting=false
        wsState.socketReady=false
        wsState.attached=false
        recordMobileDebug('ws-ticket-error')
        wsState.onError?.()
      })
      return
    }
    openSocket(getWebSocketBase())
  },[clearConnectTimer,clearPongTimer,clearRecoveryTimer,sendPing,updateConnection])
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
    armRecoveryReload()
    const baseDelay=wsState.reconnectCount===1?400:preferences.reconnectInterval
    const delay=Math.min(baseDelay*Math.max(wsState.reconnectCount,1),30000)
    wsState.reconnectTimer=setTimeout(()=>{
      wsState.reconnectTimer=null
      connect()
    },delay)
  },[armRecoveryReload,connect,updateConnection,preferences.autoReconnect,preferences.reconnectInterval])
  const resetAndReconnect=useCallback(()=>{
    const ws=wsState.ws
    updateConnection({status:'reconnecting'})
    armRecoveryReload()
    wsState.connectAttempt+=1
    clearConnectTimer()
    clearPongTimer()
    if (ws) {
      ws.onopen=null
      ws.onmessage=null
      ws.onerror=null
      ws.onclose=null
      try {
        ws.close()
      } catch {}
    }
    wsState.ws=null
    wsState.isConnecting=false
    wsState.socketReady=false
    wsState.attached=false
    wsState.closeExpected=false
    wsState.reconnectCount=0
    reconnectCountRef.current=0
    connect()
  },[armRecoveryReload,clearConnectTimer,clearPongTimer,connect])
  const closeForBackgroundNow=useCallback(()=>{
    wsState.backgroundCloseTimer=null
    wsState.hiddenAt=Date.now()
    wsState.backgroundClosed=true
    wsState.connectAttempt+=1
    wsState.connectStartedAt=0
    clearConnectTimer()
    clearPongTimer()
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer)
      wsState.reconnectTimer=null
    }
    const ws=wsState.ws
    recordMobileDebug('ws-background-close',{readyState:ws?.readyState??-1})
    if (ws) {
      ws.onopen=null
      ws.onmessage=null
      ws.onerror=null
      ws.onclose=null
      try {
        ws.close()
      } catch {}
    }
    wsState.ws=null
    wsState.isConnecting=false
    wsState.socketReady=false
    wsState.attached=false
    updateConnection({status:'disconnected'})
  },[clearConnectTimer,clearPongTimer,updateConnection])
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
      if (resumed&&wsState.isConnecting) {
        resetAndReconnect()
        return
      }
      connect()
      return
    }
    if (resumed) {
      resetAndReconnect()
      return
    }
    if (ws.readyState===WebSocket.OPEN) {
      const stale=Date.now()-wsState.lastPongAt>15000
      if (stale) {
        resetAndReconnect()
        return
      }
      if (recover) sendPing(3000)
      return
    }
    if (ws.readyState===WebSocket.CONNECTING||ws.readyState===WebSocket.CLOSING) {
      if (recover&&Date.now()-wsState.connectStartedAt>STALE_CONNECT_RESET_MS) resetAndReconnect()
      return
    }
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
  const subscribeOutput=useCallback((hostId:string,sessionName:string,listener:(message:OutputMessage)=>void)=>{
    const key=getOutputListenerKey(hostId||'local',sessionName)
    const listeners=outputListeners.get(key)||new Set<(message:OutputMessage)=>void>()
    listeners.add(listener)
    outputListeners.set(key,listeners)
    return ()=>{
      listeners.delete(listener)
      if (listeners.size===0) outputListeners.delete(key)
    }
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
          clearConnectTimer()
          clearRecoveryTimer()
          clearPongTimer()
          wsState.connectAttempt+=1
          wsState.connectStartedAt=0
          wsState.closeExpected=false
          if (wsState.ws) {
            wsState.closeExpected=true
            wsState.ws.close()
            wsState.ws=null
          }
          wsState.reconnectCount=0
          wsState.isConnecting=false
          wsState.socketReady=false
          wsState.attached=false
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
  },[clearConnectTimer,clearRecoveryTimer,connect,ensureConnection,handleMessage,scheduleReconnect,sendPing,clearPongTimer,scheduleBackgroundClose])
  return {send,isConnected,isSocketReady,subscribeOutput}
}
