'use client'

import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { getApiBase, getWebSocketBase } from '@/lib/runtime-endpoints'
import { useTranslation } from '@/i18n'

function getShareToken() {
  const params=new URLSearchParams(window.location.hash.slice(1))
  const token=params.get('token')||window.sessionStorage.getItem('tmuxgo-share-token')||''
  if (token) window.sessionStorage.setItem('tmuxgo-share-token',token)
  if (window.location.hash) window.history.replaceState(null,'',window.location.pathname)
  return token
}
export function SharedTerminal() {
  const { t }=useTranslation()
  const terminalRef=useRef<HTMLDivElement>(null)
  const [message,setMessage]=useState(t('share.connecting'))
  const [failed,setFailed]=useState(false)
  useEffect(() => {
    let socket:WebSocket|null=null
    let terminal:{ open:(element:HTMLElement) => void; write:(data:string) => void; dispose:() => void; attachCustomKeyEventHandler:(handler:(event:KeyboardEvent) => boolean) => void; cols:number; rows:number }|null=null
    let active=true
    let connectionFailed=false
    const connect=async () => {
      const token=getShareToken()
      if (!token) throw new Error(t('share.invalid'))
      const response=await fetch(`${getApiBase()}/api/shares/exchange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})
      const result=await response.json() as { ticket?:string; hostId?:string; sessionName?:string; message?:string }
      if (!response.ok||!result.ticket||!result.hostId||!result.sessionName) throw new Error(result.message||t('share.unavailable'))
      const { Terminal }=await import('@xterm/xterm')
      if (!active||!terminalRef.current) return
      terminal=new Terminal({ cursorBlink:false, disableStdin:true, fontSize:14, fontFamily:'monospace', scrollback:6000, theme:{ background:'#101417',foreground:'#d9e1e8' } })
      terminal.attachCustomKeyEventHandler(() => false)
      terminal.open(terminalRef.current)
      const websocketBase=getWebSocketBase()
      socket=new WebSocket(`${websocketBase}${websocketBase.includes('?')?'&':'?'}ticket=${encodeURIComponent(result.ticket)}`)
      socket.onopen=() => socket?.send(JSON.stringify({type:'attach',hostId:result.hostId,sessionName:result.sessionName,cols:terminal?.cols||120,rows:terminal?.rows||36,exclusive:false}))
      socket.onmessage=(event) => {
        try {
          const data=JSON.parse(typeof event.data==='string'?event.data:String(event.data))
          if (data.type==='output'||data.type==='output_resync') terminal?.write(String(data.data||''))
          else if (data.type==='attached') setMessage(`${t('share.readOnly')} - ${data.hostId}/${data.sessionName}`)
          else if (data.type==='error') throw new Error(String(data.message||t('share.unavailable')))
        } catch (error) {
          connectionFailed=true
          setMessage(error instanceof Error?error.message:t('share.unavailable'))
          setFailed(true)
        }
      }
      socket.onclose=() => {
        if (!active||connectionFailed) return
        setMessage(t('share.disconnected'))
      }
    }
    void connect().catch((error) => {
      if (!active) return
      connectionFailed=true
      setMessage(error instanceof Error?error.message:t('share.unavailable'))
      setFailed(true)
    })
    return () => {
      active=false
      socket?.close()
      terminal?.dispose()
    }
  }, [t])
  return <main className="flex min-h-screen flex-col bg-bg-0 text-text-1"><header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4"><div className="font-mono text-xs uppercase tracking-[0.18em] text-accent">TMUXGO / SHARE</div><span className="text-xs text-text-3">{message}</span></header><div ref={terminalRef} className="min-h-0 flex-1 p-2" />{failed&&<div className="border-t border-danger/30 px-4 py-3 text-sm text-danger">{message}</div>}</main>
}
