'use client'
import { useCallback, useEffect, useMemo, useRef, useState,type PointerEvent as ReactPointerEvent,type UIEvent as ReactUIEvent } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCustomShortcuts, keysToEscape } from '@/hooks/useCustomShortcuts'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { AddShortcutModal } from './AddShortcutModal'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { api } from '@/lib/api'
import { writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { DELETE_PREV_LINE_SEQUENCE, DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'

const btn='px-2 py-1.5 rounded text-xs transition-colors bg-bg-2 text-text-2 hover:bg-bg-1 active:bg-bg-0'
const repeatBtn=`${btn} touch-none select-none`
const dockBtn='px-2.5 py-1.5 rounded-md text-[11px] leading-none whitespace-nowrap select-none transition-colors bg-bg-2 text-text-2 active:bg-bg-0 touch-pan-x'
const dockDangerBtn='px-2.5 py-1.5 rounded-md text-[11px] leading-none whitespace-nowrap select-none transition-colors bg-red-900/30 text-red-400 active:bg-red-900/50 touch-pan-x'
const dockAccentBtn='px-2.5 py-1.5 rounded-md text-[11px] leading-none whitespace-nowrap select-none transition-colors bg-accent/20 text-accent active:bg-accent/30 touch-pan-x'
const repeatDelay=260
const repeatInterval=54
const dragThreshold=12
const scrollSuppressWindow=180

type QuickActionsMode='panel'|'dock'
type ActionButtonDef={key:string,label:string,data?:string,repeat?:boolean,tone?:'default'|'accent'|'danger',disabled?:boolean,onPress?:()=>void|Promise<void>}

function useQuickActionController() {
  const { preferences, updatePreferences }=usePreferences()
  const { t }=useTranslation()
  const activeHostId=useConsoleStore((s)=>s.activeHostId)
  const activeSessionId=useConsoleStore((s)=>s.activeSessionId)
  const activePaneId=useConsoleStore((s)=>s.activePaneId)
  const pushToast=useConsoleStore((s)=>s.pushToast)
  const { data: windowsData=[] }=useWindows(activeHostId||'',activeSessionId||'')
  const { setWindows }=useWindowQueryState(activeHostId||'',activeSessionId||'')
  const [pendingDirection,setPendingDirection]=useState<'horizontal'|'vertical'|null>(null)
  const activeWindow=useMemo(()=>windowsData.find((w:any)=>w.active)||windowsData[0]||null,[windowsData])
  const canSplit=!!activeSessionId&&!!activeWindow&&!pendingDirection
  const { send }=useWebSocket()
  const { refreshSnapshot, resolveActivePaneId, resolveFreshActivePaneId } = useSessionSnapshotSync()
  const { shortcuts,addShortcut,removeShortcut }=useCustomShortcuts()
  const [showModal,setShowModal]=useState(false)
  const [isMobile,setIsMobile]=useState(false)
  const [confirmKillOpen,setConfirmKillOpen]=useState(false)
  const [pendingKillPaneId,setPendingKillPaneId]=useState<string|null>(null)
  const [newWindowPromptOpen,setNewWindowPromptOpen]=useState(false)
  const [newWindowName,setNewWindowName]=useState('')
  const repeatTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null)
  const repeatIntervalRef=useRef<ReturnType<typeof setInterval>|null>(null)
  const pointerStateRef=useRef({id:-1,x:0,y:0,moved:false,pointerType:'',repeatFired:false})
  const dockScrollRef=useRef({pointerId:-1,startScrollLeft:0,scrolling:false,suppressUntil:0})

  useEffect(()=>{
    const check=()=>setIsMobile(window.innerWidth<1024)
    check()
    window.addEventListener('resize',check)
    return ()=>window.removeEventListener('resize',check)
  },[])

  const sendKey=useCallback((data:string)=>send({ type:'input',data }),[send])
  const stopRepeat=useCallback(()=>{
    if(repeatTimerRef.current){
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current=null
    }
    if(repeatIntervalRef.current){
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current=null
    }
  },[])
  const startRepeat=useCallback((data:string)=>{
    stopRepeat()
    sendKey(data)
    repeatTimerRef.current=setTimeout(()=>{
      repeatIntervalRef.current=setInterval(()=>sendKey(data),repeatInterval)
    },repeatDelay)
  },[sendKey,stopRepeat])
  const armTouchRepeat=useCallback((data:string)=>{
    stopRepeat()
    pointerStateRef.current.repeatFired=false
    repeatTimerRef.current=setTimeout(()=>{
      pointerStateRef.current.repeatFired=true
      sendKey(data)
      repeatIntervalRef.current=setInterval(()=>sendKey(data),repeatInterval)
    },repeatDelay)
  },[sendKey,stopRepeat])
  useEffect(()=>stopRepeat,[stopRepeat])
  const preventFocus=useCallback((e:ReactPointerEvent<HTMLButtonElement>)=>{e.preventDefault()},[])
  const startPointer=useCallback((e:ReactPointerEvent<HTMLButtonElement>)=>{pointerStateRef.current={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false,pointerType:e.pointerType||'',repeatFired:false}},[])
  const resetPointer=useCallback(()=>{pointerStateRef.current={id:-1,x:0,y:0,moved:false,pointerType:'',repeatFired:false}},[])
  const startDockGesture=useCallback((e:ReactPointerEvent<HTMLDivElement>)=>{
    if(e.pointerType==='mouse')return
    dockScrollRef.current={pointerId:e.pointerId,startScrollLeft:e.currentTarget.scrollLeft,scrolling:false,suppressUntil:dockScrollRef.current.suppressUntil}
  },[])
  const trackDockScroll=useCallback((e:ReactUIEvent<HTMLDivElement>)=>{
    const state=dockScrollRef.current
    if(state.pointerId===-1){
      state.suppressUntil=Date.now()+scrollSuppressWindow
      return
    }
    if(Math.abs(e.currentTarget.scrollLeft-state.startScrollLeft)>0){
      state.scrolling=true
      state.suppressUntil=Date.now()+scrollSuppressWindow
    }
  },[])
  const finishDockGesture=useCallback((pointerId:number)=>{
    const state=dockScrollRef.current
    if(state.pointerId!==-1&&state.pointerId!==pointerId)return
    if(state.scrolling)state.suppressUntil=Date.now()+scrollSuppressWindow
    state.pointerId=-1
    state.startScrollLeft=0
    state.scrolling=false
  },[])
  const isDockScrollBlocked=useCallback(()=>dockScrollRef.current.suppressUntil>Date.now(),[])
  const trackPointer=useCallback((e:ReactPointerEvent<HTMLButtonElement>)=>{
    const state=pointerStateRef.current
    if(state.id!==e.pointerId||state.moved)return
    if(Math.abs(e.clientX-state.x)>=dragThreshold||Math.abs(e.clientY-state.y)>=dragThreshold){
      state.moved=true
      stopRepeat()
    }
  },[stopRepeat])
  const finishPointer=useCallback(()=>{
    stopRepeat()
    resetPointer()
  },[resetPointer,stopRepeat])
  useEffect(()=>{
    window.addEventListener('pointerup',stopRepeat)
    window.addEventListener('pointercancel',stopRepeat)
    window.addEventListener('touchend',stopRepeat)
    window.addEventListener('touchcancel',stopRepeat)
    window.addEventListener('blur',stopRepeat)
    document.addEventListener('visibilitychange',stopRepeat)
    return ()=>{
      stopRepeat()
      window.removeEventListener('pointerup',stopRepeat)
      window.removeEventListener('pointercancel',stopRepeat)
      window.removeEventListener('touchend',stopRepeat)
      window.removeEventListener('touchcancel',stopRepeat)
      window.removeEventListener('blur',stopRepeat)
      document.removeEventListener('visibilitychange',stopRepeat)
      resetPointer()
    }
  },[resetPointer,stopRepeat])
  const refreshSnapshotSafely=useCallback(async()=>{
    try{
      await refreshSnapshot()
    }catch{}
  },[refreshSnapshot])
  const handleSplit=useCallback(async(direction:'horizontal'|'vertical')=>{
    if(!activeWindow||pendingDirection)return
    setPendingDirection(direction)
    try{
      const paneId=await resolveFreshActivePaneId()
      if(!paneId)throw new Error(t('pane.noActive'))
      await api.panes.split(paneId,direction)
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'split-pane',direction } }))
      pushToast({ type:'success',message:t('pane.splitSuccess') })
    }catch(err){
      try{
        const paneId=await resolveFreshActivePaneId()
        if(!paneId||paneId===activePaneId)throw err
        await api.panes.split(paneId,direction)
        await refreshSnapshotSafely()
        window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'split-pane',direction } }))
        pushToast({ type:'success',message:t('pane.splitSuccess') })
      }catch(retryErr){
        pushToast({ type:'error',message:retryErr instanceof Error?retryErr.message:t('pane.splitFailed') })
      }
    }finally{
      setPendingDirection(null)
    }
  },[activePaneId,activeWindow,pendingDirection,pushToast,refreshSnapshotSafely,resolveFreshActivePaneId,t])
  const handleCopy=useCallback(()=>{
    void requestTerminalSelection().then(async(text)=>{
      if(!text)return
      const result=await writeClipboardText(text)
      if(!result.copied){
        pushToast({ type:'error',message:t('clipboard.copyFailed') })
        return
      }
      if(result.unavailable)pushToast({ type:'info',message:t('clipboard.unavailable') })
    })
  },[pushToast])
  const handlePaste=useCallback(()=>window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste')),[])
  const handleKillPane=useCallback(async()=>{
    const paneId=await resolveActivePaneId()
    if(!paneId){
      pushToast({ type:'error',message:t('pane.noActive') })
      return
    }
    useConsoleStore.setState({ activePaneId:paneId })
    setPendingKillPaneId(paneId)
    setConfirmKillOpen(true)
  },[pushToast,resolveActivePaneId,t])
  const confirmKillPane=useCallback(async()=>{
    const paneId=pendingKillPaneId||await resolveFreshActivePaneId()
    if(!paneId){
      setPendingKillPaneId(null)
      setConfirmKillOpen(false)
      pushToast({ type:'error',message:t('pane.noActive') })
      return
    }
    try{
      await api.panes.kill(paneId)
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'kill-pane' } }))
      pushToast({ type:'success',message:t('pane.closed') })
    }catch(err){
      pushToast({ type:'error',message:err instanceof Error?err.message:t('pane.closeFailed') })
    }
    setPendingKillPaneId(null)
    setConfirmKillOpen(false)
  },[pendingKillPaneId,pushToast,refreshSnapshotSafely,resolveFreshActivePaneId,t])
  const handleZoom=useCallback(async()=>{
    try{
      const paneId=await resolveFreshActivePaneId()
      if(!paneId)throw new Error(t('pane.noActive'))
      await api.panes.zoomByPane(paneId)
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'zoom-pane' } }))
    }catch(err){
      pushToast({ type:'error',message:err instanceof Error?err.message:t('pane.zoomFailed') })
    }
  },[pushToast,refreshSnapshotSafely,resolveFreshActivePaneId,t])
  const handleOpenNewWindowPrompt=useCallback(()=>{
    if(!activeHostId||!activeSessionId){
      pushToast({ type:'error',message:t('window.createMissingSession') })
      return
    }
    const baseCount=windowsData.filter((item:any)=>item.sessionId===activeSessionId).length
    setNewWindowName(`win-${baseCount+1}`)
    setNewWindowPromptOpen(true)
  },[activeHostId,activeSessionId,pushToast,t,windowsData])
  const confirmCreateWindow=useCallback(async(inputName?:string)=>{
    if(!activeHostId||!activeSessionId){
      setNewWindowPromptOpen(false)
      return
    }
    const name=(typeof inputName==='string'?inputName:newWindowName||'').trim()||'new-window'
    try{
      const created=await api.windows.create(activeHostId,activeSessionId,name)
      if(created?.id){
        const selected=await api.windows.select(activeHostId,activeSessionId,created.id)
        if(selected?.windows)setWindows(selected.windows)
        else{
          const latest=await api.windows.list(activeHostId,activeSessionId)
          if(Array.isArray(latest))setWindows(latest)
        }
      }else{
        const latest=await api.windows.list(activeHostId,activeSessionId)
        if(Array.isArray(latest))setWindows(latest)
      }
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'new-window' } }))
      pushToast({ type:'success',message:t('window.created',{ name }) })
    }catch(err){
      pushToast({ type:'error',message:err instanceof Error?err.message:t('window.createFailed') })
    }
    setNewWindowPromptOpen(false)
  },[activeHostId,activeSessionId,newWindowName,pushToast,refreshSnapshotSafely,setWindows,t])

  const primaryButtons:ActionButtonDef[]=[
    { key:'split-h',label:t('sidebar.splitH'),onPress:()=>handleSplit('horizontal'),disabled:!canSplit },
    { key:'split-v',label:t('sidebar.splitV'),onPress:()=>handleSplit('vertical'),disabled:!canSplit },
    { key:'new-window',label:t('quick.newWindow'),onPress:()=>void handleOpenNewWindowPrompt(),tone:'accent',disabled:!activeSessionId },
    { key:'esc',label:'Esc',data:'\x1b' },
    { key:'up',label:'↑',data:'\x1b[A',repeat:true },
    { key:'tab',label:'Tab',data:'\t' },
    { key:'left',label:'←',data:'\x1b[D',repeat:true },
    { key:'down',label:'↓',data:'\x1b[B',repeat:true },
    { key:'right',label:'→',data:'\x1b[C',repeat:true },
    { key:'ctrl-c',label:'Ctrl+C',data:'\x03' },
    { key:'clear-line',label:t('quick.clearLine'),data:DELETE_PREV_LINE_SEQUENCE },
    { key:'delete-word',label:t('quick.deleteWord'),data:DELETE_PREV_WORD_SEQUENCE },
    { key:'enter',label:'Enter',data:'\r' },
    { key:'zoom',label:t('quick.zoom'),onPress:()=>void handleZoom(),disabled:!activeSessionId },
    { key:'backspace',label:'Backspace',data:'\x7f' },
    { key:'copy',label:t('quick.copy'),onPress:handleCopy,tone:'accent' },
    { key:'paste',label:t('quick.paste'),onPress:handlePaste,tone:'accent' },
    { key:'kill-pane',label:t('quick.killPane'),onPress:()=>void handleKillPane(),tone:'danger',disabled:!activeSessionId },
  ]
  const attachButton:ActionButtonDef={ key:'attach-mode',label:preferences.attachExclusive?t('quick.attachExclusive'):t('quick.attachShared'),onPress:()=>updatePreferences({ attachExclusive:!preferences.attachExclusive }),tone:'accent' }

  return { t,shortcuts,addShortcut,removeShortcut,showModal,setShowModal,isMobile,confirmKillOpen,setConfirmKillOpen,pendingKillPaneId,setPendingKillPaneId,confirmKillPane,newWindowPromptOpen,setNewWindowPromptOpen,newWindowName,setNewWindowName,confirmCreateWindow,sendKey,startRepeat,armTouchRepeat,stopRepeat,preventFocus,startPointer,startDockGesture,trackDockScroll,finishDockGesture,isDockScrollBlocked,trackPointer,finishPointer,pointerStateRef,primaryButtons,attachButton }
}

function getDockClass(def:ActionButtonDef){
  if(def.tone==='danger')return `${dockDangerBtn}${def.disabled?' opacity-60 cursor-not-allowed':''}`
  if(def.tone==='accent')return `${dockAccentBtn}${def.disabled?' opacity-60 cursor-not-allowed':''}`
  return `${dockBtn}${def.disabled?' bg-bg-2/60 text-text-3 cursor-not-allowed':''}`
}

function getPanelClass(def:ActionButtonDef){
  if(def.tone==='danger')return `px-2 py-1.5 rounded text-xs transition-colors ${def.disabled?'bg-bg-2/60 text-text-3 cursor-not-allowed':'bg-red-900/30 text-red-400 hover:bg-red-900/50'}`
  if(def.disabled)return 'px-2 py-1.5 rounded text-xs transition-colors bg-bg-2/60 text-text-3 cursor-not-allowed'
  if(def.repeat)return repeatBtn
  return def.tone==='accent'?'px-2 py-1.5 rounded text-xs transition-colors bg-accent/20 text-accent hover:bg-accent/25':btn
}

function renderPanelButton(def:ActionButtonDef,controller:ReturnType<typeof useQuickActionController>){
  const { sendKey,startRepeat,stopRepeat }=controller
  if(def.repeat&&def.data){
    return <button key={def.key} onPointerDown={()=>startRepeat(def.data!)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} className={getPanelClass(def)} disabled={def.disabled}>{def.label}</button>
  }
  return <button key={def.key} onClick={()=>{ if(def.disabled)return; if(def.onPress)return def.onPress(); if(def.data)sendKey(def.data) }} className={getPanelClass(def)} disabled={def.disabled}>{def.label}</button>
}

function renderDockButton(def:ActionButtonDef,controller:ReturnType<typeof useQuickActionController>){
  const { sendKey,startRepeat,armTouchRepeat,preventFocus,startPointer,trackPointer,finishPointer,finishDockGesture,isDockScrollBlocked,pointerStateRef }=controller
  return <button key={def.key} type="button" tabIndex={-1} className={getDockClass(def)} onPointerDown={(e)=>{ preventFocus(e); startPointer(e); if(def.disabled)return; if(def.repeat&&def.data){ if(e.pointerType!=='mouse'){ armTouchRepeat(def.data); return } startRepeat(def.data); return } }} onPointerMove={trackPointer} onPointerUp={(e)=>{ const { moved,pointerType,repeatFired }=pointerStateRef.current; const blocked=isDockScrollBlocked(); finishPointer(); finishDockGesture(e.pointerId); if(moved||blocked||def.disabled)return; if(def.repeat&&def.data){ if(pointerType!=='mouse'){ if(!repeatFired)sendKey(def.data); return } return } if(def.onPress){ void def.onPress(); return } if(def.data)sendKey(def.data) }} onPointerLeave={finishPointer} onPointerCancel={(e)=>{ finishPointer(); finishDockGesture(e.pointerId) }}>{def.label}</button>
}

export function QuickActions({ mode='panel' }:{ mode?:QuickActionsMode }){
  const controller=useQuickActionController()
  const { t,shortcuts,addShortcut,removeShortcut,showModal,setShowModal,isMobile,confirmKillOpen,setConfirmKillOpen,pendingKillPaneId,setPendingKillPaneId,confirmKillPane,newWindowPromptOpen,setNewWindowPromptOpen,newWindowName,setNewWindowName,confirmCreateWindow,sendKey,primaryButtons,attachButton }=controller
  if(mode==='dock'){
    return (
      <>
        <div data-shortcut-bar data-keep-mobile-keyboard className="mobile-nav-landscape-hide relative z-40 flex-shrink-0 bg-bg-1 border-t border-[var(--line)] overflow-x-auto scrollbar-none pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(0,0,0,0.28)]" style={{ minHeight:40 }} onPointerDownCapture={controller.startDockGesture} onPointerUpCapture={(e)=>controller.finishDockGesture(e.pointerId)} onPointerCancelCapture={(e)=>controller.finishDockGesture(e.pointerId)} onScroll={controller.trackDockScroll} onContextMenu={(e)=>e.preventDefault()}>
          <div className="flex gap-1 p-1.5 w-max min-h-[40px] items-center" onContextMenu={(e)=>e.preventDefault()}>
            {primaryButtons.map((def)=>renderDockButton(def,controller))}
            <div className="w-px bg-[var(--line)] mx-1 self-stretch" />
            {renderDockButton(attachButton,controller)}
            {shortcuts.map((s)=>renderDockButton({ key:s.id,label:s.label,onPress:()=>{ sendKey(keysToEscape(s.keys)) } },controller))}
          </div>
        </div>
        <ConfirmDialog open={confirmKillOpen} title={t('quick.killTitle')} message={t('quick.killConfirm')} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={()=>{ setPendingKillPaneId(null); setConfirmKillOpen(false) }} onConfirm={()=>void confirmKillPane()} />
        <PromptDialog open={newWindowPromptOpen} title={t('window.createTitle')} defaultValue={newWindowName} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={()=>setNewWindowPromptOpen(false)} onConfirm={(value)=>{ setNewWindowName(value); void confirmCreateWindow(value) }} />
      </>
    )
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1">
        {primaryButtons.slice(0,3).map((def)=>renderPanelButton(def,controller))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {primaryButtons.slice(3,9).map((def)=>renderPanelButton(def,controller))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {primaryButtons.slice(9,12).map((def)=>renderPanelButton(def,controller))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {primaryButtons.slice(12,15).map((def)=>renderPanelButton(def,controller))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {primaryButtons.slice(15,18).map((def)=>renderPanelButton(def,controller))}
      </div>
      <button onClick={()=>attachButton.onPress?.()} className="w-full px-2 py-1.5 rounded text-xs transition-colors bg-accent/20 text-accent border border-accent/40 hover:bg-accent/25">
        {attachButton.label}
      </button>
      {shortcuts.length>0&&(
        <div className="border-t border-[var(--line)] pt-2">
          <div className="text-text-3 text-[10px] mb-1">{t('shortcut.custom')}</div>
          {shortcuts.map((s)=>(
            <div key={s.id} className="group flex items-center gap-1 mb-1">
              <button onClick={()=>sendKey(keysToEscape(s.keys))} className={btn+' flex-1 truncate'} title={s.keys}>
                {s.label}
              </button>
              <button onClick={()=>removeShortcut(s.id)} className="p-1 rounded text-text-3 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <button onClick={()=>setShowModal(true)} className="w-full px-2 py-1.5 rounded text-xs transition-colors border border-dashed border-[var(--line)] text-text-3 hover:text-text-2 hover:border-accent/50">
        + {t('shortcut.add')}
      </button>
      {showModal&&(
        <AddShortcutModal
          isMobile={isMobile}
          onSave={(data)=>{
            addShortcut(data)
            setShowModal(false)
          }}
          onClose={()=>setShowModal(false)}
        />
      )}
      <ConfirmDialog open={confirmKillOpen} title={t('quick.killTitle')} message={t('quick.killConfirm')} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={()=>{ setPendingKillPaneId(null); setConfirmKillOpen(false) }} onConfirm={()=>void confirmKillPane()} />
      <PromptDialog open={newWindowPromptOpen} title={t('window.createTitle')} defaultValue={newWindowName} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={()=>setNewWindowPromptOpen(false)} onConfirm={(value)=>{ setNewWindowName(value); void confirmCreateWindow(value) }} />
    </div>
  )
}
