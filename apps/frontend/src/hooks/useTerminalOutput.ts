'use client'
import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { TerminalPerfState } from '@/types'

const TERMINAL_OUTPUT_METRIC_FLUSH_MS = 500

export function useTerminalOutput() {
  const updateTerminalPerf = useConsoleStore((state) => state.updateTerminalPerf)
  const pendingRef = useRef({ bytes: 0, events: 0, backlog: 0, lastOutputAt: '' })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending.events) return
    pendingRef.current = { bytes: 0, events: 0, backlog: 0, lastOutputAt: '' }
    const perf = useConsoleStore.getState().terminalPerf
    updateTerminalPerf({
      outputBytes: perf.outputBytes + pending.bytes,
      outputEvents: perf.outputEvents + pending.events,
      outputBacklog: pending.backlog,
      lastOutputAt: pending.lastOutputAt,
    })
  }, [updateTerminalPerf])
  useEffect(() => () => flush(), [flush])
  return useCallback((_perf: TerminalPerfState, raw: string, outputLength: number, backlogLength: number) => {
    const pending = pendingRef.current
    pending.bytes += raw.length
    pending.events += 1
    pending.backlog = backlogLength + outputLength
    pending.lastOutputAt = new Date().toISOString()
    if (!timerRef.current) timerRef.current = setTimeout(flush, TERMINAL_OUTPUT_METRIC_FLUSH_MS)
  }, [flush])
}
