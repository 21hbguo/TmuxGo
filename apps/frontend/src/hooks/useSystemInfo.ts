'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'

export interface SystemInfo {
  hostId: string
  gpu: { used: number; total: number } | null
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; used: number; total: number }[]
  net: {
    sentBytes: number
    recvBytes: number
    daySentBytes?: number
    dayRecvBytes?: number
    last24hSentBytes?: number
    last24hRecvBytes?: number
    trackedMs?: number
    windowMs?: number
  }
  dependencies: { tmux: boolean; git: boolean; python: boolean; rg: boolean; sshpass: boolean }
  stream: {
    outputBytes: number
    outputChunks: number
    outputFlushes: number
    outputResyncRequests: number
    outputResyncCompleted: number
    droppedOutputChars: number
    sanitizeCalls: number
    sanitizeChars: number
    attachRequests: number
    snapshotRequests: number
    resizeRequests: number
    inputMessages: number
    backpressureSignals: number
    backpressureSuppressed: number
    profileUpdates: number
    deferredFlushes: number
    socketBufferedBytes: number
    activeClients: number
    activeProfile: 'foreground' | 'background' | 'mobile'
    activeFlushInterval: number
    activeMaxChars: number
    compressFrames: number
    compressBytesIn: number
    compressBytesOut: number
    cellSnapshots: number
    cellDiffs: number
    cellFallbackAnsi: number
    cellDirtyCells: number
  }
}

export function useSystemInfo(hostId = 'local', interval = 2000, enabled = true, refreshToken = 0) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    let active = true
    setInfo(null)
    if (!enabled) {
      return () => {
        active = false
      }
    }
    // 慢于轮询周期的响应会与下一次 setInterval 触发重叠：在途时直接跳过，
    // 保证同一主机最多一个请求并发，避免旧响应乱序覆盖新数据
    let inflight = false
    const poll = async () => {
      if (inflight) return
      inflight = true
      try {
        const data = await api.system.info(hostId)
        if (active) setInfo(data)
      } catch {
        // 轮询失败静默忽略，等下一周期重试；inflight 仍需复位
      } finally {
        inflight = false
      }
    }
    poll()
    timerRef.current = setInterval(poll, interval)
    return () => {
      active = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [hostId, interval, enabled, refreshToken])

  return info
}
