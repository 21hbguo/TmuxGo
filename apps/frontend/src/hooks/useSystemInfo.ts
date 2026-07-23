'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'

export interface SystemInfo {
  hostId: string
  gpu: { used: number; total: number } | null
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; used: number; total: number }[]
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
    profileUpdates: number
    deferredFlushes: number
    socketBufferedBytes: number
    activeClients: number
    activeProfile: 'foreground' | 'background' | 'mobile'
    activeFlushInterval: number
    activeMaxChars: number
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
    const poll = async () => {
      try {
        const data = await api.system.info(hostId)
        if (active) setInfo(data)
      } catch {}
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
