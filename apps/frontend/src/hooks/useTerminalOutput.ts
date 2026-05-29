'use client'
import { useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { TerminalPerfState } from '@/types'

export function useTerminalOutput() {
  const updateTerminalPerf = useConsoleStore((state) => state.updateTerminalPerf)
  return useCallback((perf: TerminalPerfState, raw: string, outputLength: number, backlogLength: number) => {
    updateTerminalPerf({
      outputBytes: perf.outputBytes + raw.length,
      outputEvents: perf.outputEvents + 1,
      outputBacklog: backlogLength + outputLength,
      lastOutputAt: new Date().toISOString(),
    })
  }, [updateTerminalPerf])
}
