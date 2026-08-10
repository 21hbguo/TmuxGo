'use client'
import { useCallback, useEffect, useMemo, useRef, useState,type PointerEvent as ReactPointerEvent,type UIEvent as ReactUIEvent } from 'react'
import { setImmersiveFullscreenMode, usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCustomShortcuts, shortcutToSteps, stepToInput, describeShortcut } from '@/hooks/useCustomShortcuts'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { AddShortcutModal } from './AddShortcutModal'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { MobileBottomSheet } from './MobileBottomSheet'
import { api } from '@/lib/api'
import { writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { DELETE_PREV_LINE_SEQUENCE, DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'
import { WatchButton } from './PaneNotifications'
import { KeyCap } from './KeyCap'
import { FiEdit2, FiTrash2 } from 'react-icons/fi'
import type { CustomShortcut } from '@/types'

const repeatDelay=300
const repeatInterval=33
const verticalRepeatDelay=420
const verticalRepeatInterval=140
const dragThreshold=12
const scrollSuppressWindow=180
const RECENT_DOCK_SHORTCUTS_KEY = 'tmuxgo-recent-dock-shortcuts'
const RECENT_DOCK_SHORTCUT_LIMIT = 6

type QuickActionsMode='panel'|'dock'
type ActionButtonDef={key:string,label:string,data?:string,repeat?:boolean,repeatDelay?:number,repeatInterval?:number,tone?:'default'|'accent'|'danger',disabled?:boolean,busy?:boolean,onPress?:()=>void|Promise<void>}

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
  const { refreshSnapshot, resolveFreshActivePaneId, optimisticallyToggleWindowZoom, discardOptimisticWindowZoom } = useSessionSnapshotSync()
  const { shortcuts,addShortcut,updateShortcut,removeShortcut,removeShortcuts }=useCustomShortcuts()
  const [showModal,setShowModal]=useState(false)
  const [editingShortcut,setEditingShortcut]=useState<typeof shortcuts[number]|null>(null)
  const [pendingShortcutDeletes,setPendingShortcutDeletes]=useState<typeof shortcuts>([])
  const [isMobile,setIsMobile]=useState(false)
  const [recentDockShortcutKeys,setRecentDockShortcutKeys]=useState<string[]>([])
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
  useEffect(()=>{
    if(typeof window==='undefined')return
    try{
      const raw=JSON.parse(localStorage.getItem(RECENT_DOCK_SHORTCUTS_KEY)||'[]')
      setRecentDockShortcutKeys(Array.isArray(raw)?raw.filter((item):item is string=>typeof item==='string'&&item.length>0):[])
    }catch{
      setRecentDockShortcutKeys([])
    }
  },[])

  const sendKey=useCallback((data:string)=>send({ type:'input',data }),[send])
  const macroRunIdRef=useRef(0)
  const [runningShortcutId,setRunningShortcutId]=useState<string|null>(null)
  const runShortcut=useCallback((s:CustomShortcut)=>{
    const runId=++macroRunIdRef.current
    setRunningShortcutId(s.id)
    void (async()=>{
      try{
        for(const step of shortcutToSteps(s)){
          if(runId!==macroRunIdRef.current)return
          if(step.type==='wait'){
            await new Promise((resolve)=>setTimeout(resolve,step.ms||0))
            continue
          }
          sendKey(stepToInput(step))
        }
      }finally{
        if(runId===macroRunIdRef.current)setRunningShortcutId(null)
      }
    })().catch(()=>{})
  },[sendKey])
  const trackDockShortcutUse=useCallback((key:string)=>{
    if(typeof window==='undefined'||!key)return
    setRecentDockShortcutKeys((prev)=>{
      const next=[key,...prev.filter((item)=>item!==key)].slice(0,RECENT_DOCK_SHORTCUT_LIMIT)
      localStorage.setItem(RECENT_DOCK_SHORTCUTS_KEY,JSON.stringify(next))
      return next
    })
  },[])
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
  const startRepeat=useCallback((data:string,delay=repeatDelay,interval=repeatInterval)=>{
    stopRepeat()
    sendKey(data)
    repeatTimerRef.current=setTimeout(()=>{
      repeatIntervalRef.current=setInterval(()=>sendKey(data),interval)
    },delay)
  },[sendKey,stopRepeat])
  const armTouchRepeat=useCallback((data:string,delay=repeatDelay,interval=repeatInterval)=>{
    stopRepeat()
    pointerStateRef.current.repeatFired=false
    repeatTimerRef.current=setTimeout(()=>{
      pointerStateRef.current.repeatFired=true
      sendKey(data)
      repeatIntervalRef.current=setInterval(()=>sendKey(data),interval)
    },delay)
  },[sendKey,stopRepeat])
  useEffect(()=>stopRepeat,[stopRepeat])
  useEffect(()=>()=>{ macroRunIdRef.current++ },[])
  const preventFocus=useCallback((e:ReactPointerEvent<HTMLButtonElement>)=>{e.preventDefault()},[])
  const startPointer=useCallback((e:ReactPointerEvent<HTMLButtonElement>)=>{pointerStateRef.current={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false,pointerType:e.pointerType||'',repeatFired:false}},[])
  const resetPointer=useCallback(()=>{pointerStateRef.current={id:-1,x:0,y:0,moved:false,pointerType:'',repeatFired:false}},[])
  const startDockGesture=useCallback((e:ReactPointerEvent<HTMLDivElement>)=>{
    if(e.pointerType==='mouse')return
    dockScrollRef.current={pointerId:e.pointerId,startScrollLeft:e.currentTarget.scrollLeft,scrolling:false,suppressUntil:0}
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
    const paneId=await resolveFreshActivePaneId()
    if(!paneId){
      pushToast({ type:'error',message:t('pane.noActive') })
      return
    }
    useConsoleStore.setState({ activePaneId:paneId })
    setPendingKillPaneId(paneId)
    setConfirmKillOpen(true)
  },[pushToast,resolveFreshActivePaneId,t])
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
    let paneId:string|null=null
    try{
      paneId=await resolveFreshActivePaneId()
      if(!paneId)throw new Error(t('pane.noActive'))
      optimisticallyToggleWindowZoom(paneId)
      await api.panes.zoomByPane(paneId)
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change',{ detail:{ reason:'zoom-pane' } }))
    }catch(err){
      if(paneId){
        discardOptimisticWindowZoom(paneId)
        await refreshSnapshotSafely()
      }
      pushToast({ type:'error',message:err instanceof Error?err.message:t('pane.zoomFailed') })
    }
  },[discardOptimisticWindowZoom,optimisticallyToggleWindowZoom,pushToast,refreshSnapshotSafely,resolveFreshActivePaneId,t])
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
  const confirmDeleteShortcut=useCallback(()=>{
    if(pendingShortcutDeletes.length>0)removeShortcuts(pendingShortcutDeletes.map((s)=>s.id))
    setPendingShortcutDeletes([])
  },[pendingShortcutDeletes,removeShortcuts])

  const primaryButtons:ActionButtonDef[]=[
    { key:'split-h',label:t('sidebar.splitH'),onPress:()=>handleSplit('horizontal'),disabled:!canSplit },
    { key:'split-v',label:t('sidebar.splitV'),onPress:()=>handleSplit('vertical'),disabled:!canSplit },
    { key:'new-window',label:t('quick.newWindow'),onPress:()=>void handleOpenNewWindowPrompt(),tone:'accent',disabled:!activeSessionId },
    { key:'esc',label:'Esc',data:'\x1b' },
    { key:'up',label:'↑',data:'\x1b[A',repeat:true,repeatDelay:verticalRepeatDelay,repeatInterval:verticalRepeatInterval },
    { key:'tab',label:'Tab',data:'\t' },
    { key:'left',label:'←',data:'\x1b[D',repeat:true },
    { key:'down',label:'↓',data:'\x1b[B',repeat:true,repeatDelay:verticalRepeatDelay,repeatInterval:verticalRepeatInterval },
    { key:'right',label:'→',data:'\x1b[C',repeat:true },
    { key:'ctrl-c',label:'Ctrl+C',data:'\x03' },
    { key:'clear-line',label:t('quick.clearLine'),data:DELETE_PREV_LINE_SEQUENCE },
    { key:'delete-word',label:t('quick.deleteWord'),data:DELETE_PREV_WORD_SEQUENCE },
    { key:'enter',label:'Enter',data:'\r' },
    { key:'zoom',label:t('quick.zoom'),onPress:()=>void handleZoom(),disabled:!activeSessionId },
    { key:'backspace',label:'⌫',data:'\x7f',repeat:true },
    { key:'copy',label:t('quick.copy'),onPress:handleCopy,tone:'accent' },
    { key:'paste',label:t('quick.paste'),onPress:handlePaste,tone:'accent' },
    { key:'kill-pane',label:t('quick.killPane'),onPress:()=>void handleKillPane(),tone:'danger',disabled:!activeSessionId },
  ]
  const attachButton:ActionButtonDef={ key:'attach-mode',label:preferences.attachExclusive?t('quick.attachExclusive'):t('quick.attachShared'),onPress:()=>updatePreferences({ attachExclusive:!preferences.attachExclusive }),tone:'accent' }
  const fullscreenButton:ActionButtonDef={ key:'immersive-fullscreen',label:preferences.immersiveFullscreen?t('quick.exitFullscreen'):t('quick.fullscreen'),tone:'accent',onPress:async()=>{
    try{
      await setImmersiveFullscreenMode(!preferences.immersiveFullscreen)
    }catch{
      pushToast({ type:'error',message:t('settings.immersiveFullscreenFailed') })
    }
  } }
  const dockCoreButtons:ActionButtonDef[]=[
    { key:'dock-esc',label:'Esc',data:'\x1b' },
    { key:'dock-tab',label:'Tab',data:'\t' },
    { key:'dock-ctrl-c',label:'Ctrl+C',data:'\x03' },
    { key:'dock-ctrl-d',label:'Ctrl+D',data:'\x04' },
    { key:'dock-ctrl-z',label:'Ctrl+Z',data:'\x1a' },
  ]
  const recentShortcutButtons=useMemo(()=>{
    const mapped=recentDockShortcutKeys.map((key)=>shortcuts.find((item)=>item.id===key)).filter(Boolean) as typeof shortcuts
    const seen=new Set(mapped.map((item)=>item.id))
    return [...mapped,...shortcuts.filter((item)=>!seen.has(item.id))]
  },[recentDockShortcutKeys,shortcuts])

  return { t,activePaneId,shortcuts,recentShortcutButtons,addShortcut,updateShortcut,removeShortcuts,showModal,setShowModal,editingShortcut,setEditingShortcut,isMobile,pendingShortcutDeletes,setPendingShortcutDeletes,confirmDeleteShortcut,confirmKillOpen,setConfirmKillOpen,pendingKillPaneId,setPendingKillPaneId,confirmKillPane,newWindowPromptOpen,setNewWindowPromptOpen,newWindowName,setNewWindowName,confirmCreateWindow,sendKey,runShortcut,runningShortcutId,trackDockShortcutUse,startRepeat,armTouchRepeat,stopRepeat,preventFocus,startPointer,startDockGesture,trackDockScroll,finishDockGesture,isDockScrollBlocked,trackPointer,finishPointer,pointerStateRef,primaryButtons,attachButton,fullscreenButton,dockCoreButtons }
}

function triggerDockButton(def:ActionButtonDef,controller:ReturnType<typeof useQuickActionController>){
  if(def.disabled)return
  if(def.onPress){
    controller.trackDockShortcutUse(def.key)
    void def.onPress()
    return
  }
  if(def.data){
    controller.sendKey(def.data)
    controller.trackDockShortcutUse(def.key)
  }
}

function renderPanelButton(def:ActionButtonDef,controller:ReturnType<typeof useQuickActionController>){
  const send=()=>{
    if(def.disabled)return
    if(def.onPress)return def.onPress()
    if(def.data)controller.sendKey(def.data)
  }
  return <KeyCap key={def.key} variant="panel" tone={def.tone} disabled={def.disabled} repeat={def.repeat} repeatDelay={def.repeatDelay} repeatInterval={def.repeatInterval} onPress={send} title={def.label} className={def.busy ? 'animate-pulse' : undefined}>{def.label}</KeyCap>
}

function renderDockButton(def:ActionButtonDef,controller:ReturnType<typeof useQuickActionController>){
  const { startRepeat,armTouchRepeat,preventFocus,startPointer,trackPointer,finishPointer,finishDockGesture,isDockScrollBlocked,pointerStateRef }=controller
  return <KeyCap key={def.key} variant="dock" tone={def.tone} disabled={def.disabled} tabIndex={-1} title={def.label} className={def.busy ? 'animate-pulse' : undefined}
    onPointerDown={(e)=>{
      preventFocus(e); startPointer(e)
      if(def.disabled)return
      if(def.repeat&&def.data){
        if(e.pointerType!=='mouse'){ armTouchRepeat(def.data,def.repeatDelay,def.repeatInterval); return }
        startRepeat(def.data,def.repeatDelay,def.repeatInterval)
      }
    }}
    onPointerMove={trackPointer}
    onPointerUp={(e)=>{
      const { moved,pointerType,repeatFired }=pointerStateRef.current
      const blocked=isDockScrollBlocked()
      finishPointer(); finishDockGesture(e.pointerId)
      if(moved||blocked||def.disabled)return
      if(def.repeat&&def.data){
        if(pointerType!=='mouse'&&!repeatFired)triggerDockButton(def,controller)
        return
      }
      triggerDockButton(def,controller)
    }}
    onPointerCancel={(e)=>{ finishPointer(); finishDockGesture(e.pointerId) }}
    onPointerLeave={finishPointer}
    onClick={(e)=>{ if(e.detail!==0)return; triggerDockButton(def,controller) }}
  >{def.label}</KeyCap>
}

export function QuickActions({ mode='panel', onOpenFiles }:{ mode?:QuickActionsMode; onOpenFiles?:()=>void }){
  const controller=useQuickActionController()
  const { t,activePaneId,shortcuts,recentShortcutButtons,addShortcut,updateShortcut,removeShortcuts,showModal,setShowModal,editingShortcut,setEditingShortcut,isMobile,pendingShortcutDeletes,setPendingShortcutDeletes,confirmDeleteShortcut,confirmKillOpen,setConfirmKillOpen,pendingKillPaneId,setPendingKillPaneId,confirmKillPane,newWindowPromptOpen,setNewWindowPromptOpen,newWindowName,setNewWindowName,confirmCreateWindow,sendKey,runShortcut,runningShortcutId,primaryButtons,attachButton,fullscreenButton,dockCoreButtons }=controller
  const [managingShortcuts,setManagingShortcuts]=useState(false)
  const [selectedShortcutIds,setSelectedShortcutIds]=useState<string[]>([])
  const [dockManageOpen,setDockManageOpen]=useState(false)
  const closeShortcutManage=()=>{ setManagingShortcuts(false); setSelectedShortcutIds([]) }
  const toggleManageShortcuts=()=>{
    if(!managingShortcuts){ setManagingShortcuts(true); return }
    if(selectedShortcutIds.length>0){
      const target=shortcuts.find((s)=>s.id===selectedShortcutIds[0])
      if(target){ closeShortcutManage(); setEditingShortcut(target); setShowModal(true); return }
    }
    closeShortcutManage()
  }
  const toggleSelectShortcut=(id:string)=>{
    setSelectedShortcutIds((prev)=>prev.includes(id)?prev.filter((item)=>item!==id):[...prev,id])
  }
  const requestDeleteSelectedShortcut=()=>{
    const targets=shortcuts.filter((s)=>selectedShortcutIds.includes(s.id))
    if(targets.length>0)setPendingShortcutDeletes(targets)
  }
  const confirmDeleteSelectedShortcut=()=>{ confirmDeleteShortcut(); closeShortcutManage() }
  if(mode==='dock'){
    return (
      <>
        <div className="mobile-nav-landscape-hide relative z-40 flex-shrink-0 bg-bg-1 border-t border-[var(--line)]">
          <div data-shortcut-bar data-keep-mobile-keyboard className="overflow-x-auto scrollbar-none pb-[env(safe-area-inset-bottom)]" style={{ minHeight:40 }} onPointerDownCapture={controller.startDockGesture} onPointerUpCapture={(e)=>controller.finishDockGesture(e.pointerId)} onPointerCancelCapture={(e)=>controller.finishDockGesture(e.pointerId)} onScroll={controller.trackDockScroll} onContextMenu={(e)=>e.preventDefault()}>
          <div className="flex gap-1 p-1.5 w-max min-h-[40px] items-center" onContextMenu={(e)=>e.preventDefault()}>
            {recentShortcutButtons.map((s)=>renderDockButton({ key:s.id,label:s.label,busy:runningShortcutId===s.id,onPress:()=>{ runShortcut(s) } },controller))}
            {recentShortcutButtons.length>0&&<div className="w-px bg-[var(--line)] mx-1 self-stretch" />}
            {dockCoreButtons.map((def)=>renderDockButton(def,controller))}
            <div className="w-px bg-[var(--line)] mx-1 self-stretch" />
            {renderDockButton({ key:'files',label:t('nav.files'),onPress:onOpenFiles,tone:'accent' },controller)}
            {primaryButtons.map((def)=>renderDockButton(def,controller))}
            <div className="w-px bg-[var(--line)] mx-1 self-stretch" />
            {renderDockButton(attachButton,controller)}
            {renderDockButton(fullscreenButton,controller)}
            <WatchButton paneId={activePaneId || ''} compact />
            <KeyCap variant="dock" aria-label={t('shortcut.manage')} title={t('shortcut.manage')} onPress={()=>setDockManageOpen(true)}>
              <FiEdit2 aria-hidden="true" size={14} />
            </KeyCap>
          </div>
        </div>
        </div>
        <MobileBottomSheet open={dockManageOpen} onClose={()=>setDockManageOpen(false)} ariaLabel={t('shortcut.manage')}>
          <div className="px-4 pt-4 pb-2 overflow-y-auto">
            <div className="text-text-1 text-sm font-medium mb-2">{t('shortcut.custom')}</div>
            {shortcuts.map((s)=>(
              <div key={s.id} className="flex items-center gap-1 py-1">
                <div className="flex-1 truncate text-sm text-text-1">{s.label}</div>
                <button type="button" onClick={()=>{ setDockManageOpen(false); setEditingShortcut(s); setShowModal(true) }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-accent/15 hover:text-accent focus-visible:bg-accent/15 focus-visible:text-accent" aria-label={t('shortcut.edit')} title={t('shortcut.edit')}>
                  <FiEdit2 aria-hidden="true" size={13} />
                </button>
                <button type="button" onClick={()=>setPendingShortcutDeletes([s])} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-danger/15 hover:text-danger focus-visible:bg-danger/15 focus-visible:text-danger" aria-label={t('shortcut.delete')} title={t('shortcut.delete')}>
                  <FiTrash2 aria-hidden="true" size={13} />
                </button>
              </div>
            ))}
            <button onClick={()=>{ setDockManageOpen(false); setEditingShortcut(null); setShowModal(true) }} className="w-full px-2 py-1.5 rounded-apple text-xs transition-colors border border-dashed border-[var(--line)] text-text-3 hover:text-text-2 hover:border-accent/50 mt-1">
              + {t('shortcut.add')}
            </button>
          </div>
        </MobileBottomSheet>
        {showModal&&(
          <AddShortcutModal
            key={editingShortcut?.id || 'new'}
            isMobile={isMobile}
            initialShortcut={editingShortcut || undefined}
            onSave={(data)=>{
              if (editingShortcut) updateShortcut(editingShortcut.id,data)
              else addShortcut(data)
              setEditingShortcut(null)
              setShowModal(false)
            }}
            onClose={()=>{ setEditingShortcut(null); setShowModal(false) }}
          />
        )}
        <ConfirmDialog open={pendingShortcutDeletes.length>0} title={t('shortcut.deleteTitle')} message={pendingShortcutDeletes.length===1?t('shortcut.deleteConfirm',{ label:pendingShortcutDeletes[0]?.label || '' }):t('shortcut.deleteConfirmMany',{ count:pendingShortcutDeletes.length })} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={()=>setPendingShortcutDeletes([])} onConfirm={confirmDeleteShortcut} />
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
      <KeyCap variant="panel" tone="accent" onPress={()=>attachButton.onPress?.()} className="w-full" title={attachButton.label}>{attachButton.label}</KeyCap>
      <KeyCap variant="panel" tone="accent" onPress={()=>void fullscreenButton.onPress?.()} className="w-full" title={fullscreenButton.label}>{fullscreenButton.label}</KeyCap>
      <WatchButton paneId={activePaneId || ''} />
      {shortcuts.length>0&&(
        <div className="border-t border-[var(--line)] pt-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-text-3 text-caption">{t('shortcut.custom')}</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={toggleManageShortcuts} className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors focus-visible:bg-accent/15 focus-visible:text-accent ${managingShortcuts?'bg-accent/15 text-accent':'hover:bg-accent/15 hover:text-accent'}`} aria-label={t('shortcut.edit')} title={managingShortcuts&&selectedShortcutIds.length===0?t('shortcut.done'):t('shortcut.edit')}>
                <FiEdit2 aria-hidden="true" size={13} />
              </button>
              <button type="button" onClick={requestDeleteSelectedShortcut} disabled={!managingShortcuts||selectedShortcutIds.length===0} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-danger/15 hover:text-danger focus-visible:bg-danger/15 focus-visible:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-3" aria-label={t('shortcut.delete')} title={t('shortcut.delete')}>
                <FiTrash2 aria-hidden="true" size={13} />
              </button>
            </div>
          </div>
          {shortcuts.map((s)=>(
            <div key={s.id} className="group flex items-center gap-1 mb-1">
              <KeyCap variant="panel" size="md" onPress={()=>{ if(managingShortcuts){ toggleSelectShortcut(s.id); return } runShortcut(s) }} title={describeShortcut(s)} tone={managingShortcuts?(selectedShortcutIds.includes(s.id)?'accent':undefined):(runningShortcutId===s.id?'accent':undefined)} className={`flex-1 truncate ${!managingShortcuts&&runningShortcutId===s.id?'animate-pulse':''}`}>{s.label}</KeyCap>
            </div>
          ))}
        </div>
      )}
      <button onClick={()=>{ closeShortcutManage(); setEditingShortcut(null); setShowModal(true) }} className="w-full px-2 py-1.5 rounded-apple text-xs transition-colors border border-dashed border-[var(--line)] text-text-3 hover:text-text-2 hover:border-accent/50">
        + {t('shortcut.add')}
      </button>
      {showModal&&(
        <AddShortcutModal
          key={editingShortcut?.id || 'new'}
          isMobile={isMobile}
          initialShortcut={editingShortcut || undefined}
          onSave={(data)=>{
            if (editingShortcut) updateShortcut(editingShortcut.id,data)
            else addShortcut(data)
            setEditingShortcut(null)
            setShowModal(false)
          }}
          onClose={()=>{ setEditingShortcut(null); setShowModal(false) }}
        />
      )}
      <ConfirmDialog open={pendingShortcutDeletes.length>0} title={t('shortcut.deleteTitle')} message={pendingShortcutDeletes.length===1?t('shortcut.deleteConfirm',{ label:pendingShortcutDeletes[0]?.label || '' }):t('shortcut.deleteConfirmMany',{ count:pendingShortcutDeletes.length })} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={()=>setPendingShortcutDeletes([])} onConfirm={confirmDeleteSelectedShortcut} />
      <ConfirmDialog open={confirmKillOpen} title={t('quick.killTitle')} message={t('quick.killConfirm')} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={()=>{ setPendingKillPaneId(null); setConfirmKillOpen(false) }} onConfirm={()=>void confirmKillPane()} />
      <PromptDialog open={newWindowPromptOpen} title={t('window.createTitle')} defaultValue={newWindowName} confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} onCancel={()=>setNewWindowPromptOpen(false)} onConfirm={(value)=>{ setNewWindowName(value); void confirmCreateWindow(value) }} />
    </div>
  )
}
