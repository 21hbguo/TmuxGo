'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'

export interface SystemInfo {
  gpu: { used: number; total: number } | null
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; used: number; total: number }[]
}

export function useSystemInfo(interval = 2000) {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await api.system.info()
        setInfo(data)
      } catch {}
    }
    poll()
    timerRef.current = setInterval(poll, interval)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [interval])

  return info
}
