'use client'
import { useCallback, useEffect, useRef } from 'react'

const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 20
const FONT_SIZE_EPSILON = 0.04
const DISTANCE_EPSILON = 2
const DESKTOP_COMMIT_DELAY = 120

interface UseTerminalPinchOptions {
  isMobile:boolean
  terminalRef:React.MutableRefObject<any>
  preferencesRef:React.MutableRefObject<{fontSize:number}>
  updatePreferencesRef:React.MutableRefObject<(value:{fontSize:number})=>void>
  scheduleLayoutRef:React.MutableRefObject<(delay?:number,force?:boolean,resetFont?:boolean)=>void>
  touchMovedRef:React.MutableRefObject<boolean>
}

export function useTerminalPinch({isMobile,terminalRef,preferencesRef,updatePreferencesRef,scheduleLayoutRef,touchMovedRef}:UseTerminalPinchOptions) {
  const stateRef=useRef({active:false,startDistance:0,startFontSize:preferencesRef.current.fontSize,lastFontSize:preferencesRef.current.fontSize})
  const desktopCommitRef=useRef<ReturnType<typeof setTimeout>|null>(null)
  const clamp=useCallback((value:number)=>Math.max(MIN_FONT_SIZE,Math.min(MAX_FONT_SIZE,Math.round(value*10)/10)),[])
  const getDistance=useCallback((touches:TouchList)=>touches.length<2?0:Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY),[])
  const apply=useCallback((fontSize:number)=>{
    const terminal=terminalRef.current
    if (!terminal) return
    terminal.options.fontSize=fontSize
    scheduleLayoutRef.current(0,true,true)
  },[scheduleLayoutRef,terminalRef])
  const begin=useCallback((touches:TouchList)=>{
    if (!isMobile||touches.length<2) return
    const distance=getDistance(touches)
    if (!Number.isFinite(distance)||distance<DISTANCE_EPSILON) return
    const startFontSize=clamp(Number(terminalRef.current?.options?.fontSize)||preferencesRef.current.fontSize)
    stateRef.current={active:true,startDistance:distance,startFontSize,lastFontSize:startFontSize}
    touchMovedRef.current=true
  },[clamp,getDistance,isMobile,preferencesRef,terminalRef,touchMovedRef])
  const commit=useCallback(()=>{
    const state=stateRef.current
    if (!state.active) return
    state.active=false
    const nextFontSize=clamp(state.lastFontSize||state.startFontSize||preferencesRef.current.fontSize)
    state.startDistance=0
    state.startFontSize=nextFontSize
    state.lastFontSize=nextFontSize
    if (Math.abs(nextFontSize-preferencesRef.current.fontSize)>=FONT_SIZE_EPSILON) updatePreferencesRef.current({fontSize:nextFontSize})
  },[clamp,preferencesRef,updatePreferencesRef])
  const handleTouchStart=useCallback((event:TouchEvent)=>{
    if (isMobile&&event.touches.length>=2) begin(event.touches)
  },[begin,isMobile])
  const handleTouchMove=useCallback((event:TouchEvent)=>{
    if (!isMobile||event.touches.length<2) return
    if (!stateRef.current.active) begin(event.touches)
    if (!stateRef.current.active) return
    event.preventDefault()
    touchMovedRef.current=true
    const state=stateRef.current
    const distance=getDistance(event.touches)
    if (!Number.isFinite(distance)||distance<DISTANCE_EPSILON||state.startDistance<DISTANCE_EPSILON) return
    const nextFontSize=clamp(state.startFontSize*(distance/state.startDistance))
    if (Math.abs(nextFontSize-state.lastFontSize)<FONT_SIZE_EPSILON) return
    state.lastFontSize=nextFontSize
    apply(nextFontSize)
  },[apply,begin,clamp,getDistance,isMobile,touchMovedRef])
  const handleTouchEnd=useCallback((event:TouchEvent)=>{
    if (!stateRef.current.active) return
    touchMovedRef.current=true
    if (event.touches.length>=2) {
      const distance=getDistance(event.touches)
      if (Number.isFinite(distance)&&distance>=DISTANCE_EPSILON) {
        stateRef.current.startDistance=distance
        stateRef.current.startFontSize=stateRef.current.lastFontSize
      }
      return
    }
    commit()
  },[commit,getDistance,touchMovedRef])
  const handleTouchCancel=useCallback(()=>{
    if (!stateRef.current.active) return
    touchMovedRef.current=true
    commit()
  },[commit,touchMovedRef])
  const handleDesktopPinch=useCallback((event:WheelEvent)=>{
    const terminal=terminalRef.current
    if (isMobile||!event.ctrlKey||!terminal||!Number.isFinite(event.deltaY)||event.deltaY===0) return
    event.preventDefault()
    event.stopPropagation()
    const currentFontSize=Number(terminal.options.fontSize)||preferencesRef.current.fontSize
    const mouseWheel=event.deltaMode!==WheelEvent.DOM_DELTA_PIXEL||Math.abs(event.deltaY)>=50
    const nextFontSize=clamp(mouseWheel?currentFontSize-Math.sign(event.deltaY):currentFontSize*Math.exp(-event.deltaY*0.01))
    if (Math.abs(nextFontSize-currentFontSize)<FONT_SIZE_EPSILON) return
    apply(nextFontSize)
    if (desktopCommitRef.current) clearTimeout(desktopCommitRef.current)
    desktopCommitRef.current=setTimeout(()=>{
      desktopCommitRef.current=null
      const fontSize=Number(terminalRef.current?.options?.fontSize)||preferencesRef.current.fontSize
      if (Math.abs(fontSize-preferencesRef.current.fontSize)>=FONT_SIZE_EPSILON) updatePreferencesRef.current({fontSize})
    },DESKTOP_COMMIT_DELAY)
  },[apply,clamp,isMobile,preferencesRef,terminalRef,updatePreferencesRef])
  useEffect(()=>()=>{
    if (desktopCommitRef.current) clearTimeout(desktopCommitRef.current)
  },[])
  return {handleTouchStart,handleTouchMove,handleTouchEnd,handleTouchCancel,handleDesktopPinch}
}
