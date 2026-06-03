'use client'
import { useCallback, useEffect, useState } from 'react'
import type { SessionContinuityConfig, SessionResumePoint } from '@/types'
import { api } from '@/lib/api'

const PROFILE='default'
const STORAGE_KEY='tmuxgo-session-continuity'
const STORAGE_UPDATED_AT_KEY='tmuxgo-session-continuity-updated-at'
const REMOTE_PUSH_DEBOUNCE_MS=1000
const defaultSessionContinuity=():SessionContinuityConfig=>({enabled:true,syncToServer:true,resumeOnReconnect:true,resumeOnNewDevice:true,maxResumePoints:20,archive:{enabled:false,captureMode:'none',maxBytesPerSession:262144,retentionDays:7},resumePoints:[],updatedAt:new Date().toISOString()})
let continuityStore:SessionContinuityConfig=defaultSessionContinuity()
const listeners=new Set<(value:SessionContinuityConfig)=>void>()
let syncedWithServer=false
let remotePushTimer:ReturnType<typeof setTimeout>|null=null
let remotePushInFlight:Promise<void>|null=null
let remotePushPending:{next:SessionContinuityConfig;at:string}|null=null

function readLocalContinuity() {
  if (typeof window==='undefined') return defaultSessionContinuity()
  try {
    const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')
    const fallback=defaultSessionContinuity()
    const archiveRaw=raw&&typeof raw==='object'&&raw.archive&&typeof raw.archive==='object'?raw.archive:{}
    const resumePointsRaw=Array.isArray(raw?.resumePoints)?raw.resumePoints:[]
    const resumePoints=resumePointsRaw
      .filter((item:any)=>item&&typeof item==='object'&&typeof item.hostId==='string'&&typeof item.sessionId==='string'&&typeof item.sessionName==='string')
      .map((item:any)=>({
        hostId:String(item.hostId),
        sessionId:String(item.sessionId),
        sessionName:String(item.sessionName),
        windowId:typeof item.windowId==='string'&&item.windowId?item.windowId:null,
        paneId:typeof item.paneId==='string'&&item.paneId?item.paneId:null,
        cols:Number.isFinite(Number(item.cols))?Math.max(2,Math.min(1000,Math.round(Number(item.cols)))):120,
        rows:Number.isFinite(Number(item.rows))?Math.max(2,Math.min(1000,Math.round(Number(item.rows)))):36,
        exclusive:typeof item.exclusive==='boolean'?item.exclusive:true,
        lastSeenAt:typeof item.lastSeenAt==='string'&&item.lastSeenAt?item.lastSeenAt:new Date().toISOString(),
        lastOutputAt:typeof item.lastOutputAt==='string'&&item.lastOutputAt?item.lastOutputAt:(typeof item.lastSeenAt==='string'&&item.lastSeenAt?item.lastSeenAt:new Date().toISOString()),
      }))
    const next:SessionContinuityConfig={
      enabled:typeof raw?.enabled==='boolean'?raw.enabled:fallback.enabled,
      syncToServer:typeof raw?.syncToServer==='boolean'?raw.syncToServer:fallback.syncToServer,
      resumeOnReconnect:typeof raw?.resumeOnReconnect==='boolean'?raw.resumeOnReconnect:fallback.resumeOnReconnect,
      resumeOnNewDevice:typeof raw?.resumeOnNewDevice==='boolean'?raw.resumeOnNewDevice:fallback.resumeOnNewDevice,
      maxResumePoints:Number.isFinite(Number(raw?.maxResumePoints))?Math.max(1,Math.min(200,Math.round(Number(raw.maxResumePoints)))):fallback.maxResumePoints,
      archive:{
        enabled:typeof archiveRaw.enabled==='boolean'?archiveRaw.enabled:fallback.archive.enabled,
        captureMode:archiveRaw.captureMode==='none'||archiveRaw.captureMode==='visible'||archiveRaw.captureMode==='history'?archiveRaw.captureMode:fallback.archive.captureMode,
        maxBytesPerSession:Number.isFinite(Number(archiveRaw.maxBytesPerSession))?Math.max(0,Math.min(33554432,Math.round(Number(archiveRaw.maxBytesPerSession)))):fallback.archive.maxBytesPerSession,
        retentionDays:Number.isFinite(Number(archiveRaw.retentionDays))?Math.max(1,Math.min(3650,Math.round(Number(archiveRaw.retentionDays)))):fallback.archive.retentionDays,
      },
      resumePoints:resumePoints.sort((a:any,b:any)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt)).slice(0,Math.max(1,Math.min(200,Number(raw?.maxResumePoints)||fallback.maxResumePoints))),
      updatedAt:typeof raw?.updatedAt==='string'&&raw.updatedAt?raw.updatedAt:fallback.updatedAt,
    }
    return next
  } catch {
    return defaultSessionContinuity()
  }
}
function writeLocalContinuity(value:SessionContinuityConfig,updatedAt?:string) {
  if (typeof window==='undefined') return
  const at=updatedAt||new Date().toISOString()
  localStorage.setItem(STORAGE_KEY,JSON.stringify(value))
  localStorage.setItem(STORAGE_UPDATED_AT_KEY,at)
}
function emitContinuity(value:SessionContinuityConfig) {
  continuityStore=value
  listeners.forEach((listener)=>listener(value))
}
function mergeResumePoints(current:SessionResumePoint[],point:SessionResumePoint,maxResumePoints:number) {
  const dedup=[point,...current.filter((item)=>!(item.hostId===point.hostId&&item.sessionId===point.sessionId))]
  return dedup.sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt)).slice(0,Math.max(1,Math.min(200,maxResumePoints)))
}
function clearRemotePushTimer() {
  if (!remotePushTimer) return
  clearTimeout(remotePushTimer)
  remotePushTimer=null
}
function scheduleRemotePush() {
  if (typeof window==='undefined') return
  clearRemotePushTimer()
  remotePushTimer=setTimeout(()=>{
    remotePushTimer=null
    if (remotePushInFlight||!remotePushPending) return
    const pending=remotePushPending
    remotePushPending=null
    remotePushInFlight=(async()=>{
      try {
        await api.preferences.update({sessionContinuity:pending.next,sessionContinuityUpdatedAt:pending.at},PROFILE)
      } catch {}
      remotePushInFlight=null
      if (remotePushPending) scheduleRemotePush()
    })()
  },REMOTE_PUSH_DEBOUNCE_MS)
}

export function useSessionContinuity() {
  const [sessionContinuity,setSessionContinuity]=useState<SessionContinuityConfig>(continuityStore)
  const pushRemote=useCallback((next:SessionContinuityConfig,at:string)=>{
    if (!next.syncToServer) {
      remotePushPending=null
      clearRemotePushTimer()
      return
    }
    remotePushPending={next,at}
    if (remotePushInFlight) return
    scheduleRemotePush()
  },[])
  const updateSessionContinuity=useCallback((patch:Partial<SessionContinuityConfig>)=>{
    const now=new Date().toISOString()
    const next={...continuityStore,...patch,updatedAt:now}
    writeLocalContinuity(next,now)
    emitContinuity(next)
    pushRemote(next,now)
  },[pushRemote])
  const upsertResumePoint=useCallback((point:Omit<SessionResumePoint,'lastSeenAt'|'lastOutputAt'> & {lastSeenAt?:string;lastOutputAt?:string})=>{
    const now=new Date().toISOString()
    const base=continuityStore
    if (!base.enabled) return
    const nextPoint:SessionResumePoint={...point,lastSeenAt:point.lastSeenAt||now,lastOutputAt:point.lastOutputAt||point.lastSeenAt||now}
    const next={...base,resumePoints:mergeResumePoints(base.resumePoints,nextPoint,base.maxResumePoints),updatedAt:now}
    writeLocalContinuity(next,now)
    emitContinuity(next)
    pushRemote(next,now)
  },[pushRemote])
  const removeResumePoint=useCallback((hostId:string,sessionId:string)=>{
    const now=new Date().toISOString()
    const base=continuityStore
    const next={...base,resumePoints:base.resumePoints.filter((item)=>!(item.hostId===hostId&&item.sessionId===sessionId)),updatedAt:now}
    writeLocalContinuity(next,now)
    emitContinuity(next)
    pushRemote(next,now)
  },[pushRemote])
  useEffect(()=>{
    if (typeof window==='undefined') return
    const initial=readLocalContinuity()
    emitContinuity(initial)
    setSessionContinuity(initial)
    const handleStorage=(event:StorageEvent)=>{
      if (event.key!==STORAGE_KEY) return
      const next=readLocalContinuity()
      emitContinuity(next)
      setSessionContinuity(next)
    }
    listeners.add(setSessionContinuity)
    window.addEventListener('storage',handleStorage)
    if (!syncedWithServer) {
      syncedWithServer=true
      void (async()=>{
        try {
          const remote=await api.preferences.get(PROFILE)
          const remoteValue=remote.sessionContinuity
          const remoteUpdatedAt=remote.sessionContinuityUpdatedAt||''
          const localUpdatedAt=localStorage.getItem(STORAGE_UPDATED_AT_KEY)||''
          const localMs=Date.parse(localUpdatedAt)
          const remoteMs=Date.parse(remoteUpdatedAt)
          if (remoteValue&&typeof remoteValue==='object') {
            if (!Number.isNaN(remoteMs)&&(Number.isNaN(localMs)||remoteMs>=localMs)) {
              writeLocalContinuity(remoteValue,remoteUpdatedAt||new Date().toISOString())
              emitContinuity(remoteValue)
              setSessionContinuity(remoteValue)
              return
            }
            if (!Number.isNaN(localMs)&&(Number.isNaN(remoteMs)||localMs>remoteMs)) {
              const current=readLocalContinuity()
              await api.preferences.update({sessionContinuity:current,sessionContinuityUpdatedAt:localUpdatedAt},PROFILE)
            }
          } else {
            const current=readLocalContinuity()
            const now=new Date().toISOString()
            await api.preferences.update({sessionContinuity:current,sessionContinuityUpdatedAt:now},PROFILE)
            localStorage.setItem(STORAGE_UPDATED_AT_KEY,now)
          }
        } catch {}
      })()
    }
    return ()=>{
      listeners.delete(setSessionContinuity)
      window.removeEventListener('storage',handleStorage)
    }
  },[])
  return {sessionContinuity,updateSessionContinuity,upsertResumePoint,removeResumePoint}
}
