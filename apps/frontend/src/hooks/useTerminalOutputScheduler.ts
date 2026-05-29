'use client'
import { useCallback, useRef } from 'react'

const DEFAULT_FAST_OUTPUT_LIMIT = 24576
const DEFAULT_OUTPUT_FLUSH_LIMIT = 65536
const DEFAULT_FRAME_BUDGET = 32768
const BACKPRESSURE_HIGH_WATERMARK = 98304
const BACKPRESSURE_LOW_WATERMARK = 12288

interface UseTerminalOutputSchedulerOptions {
  fastOutputLimit?: number
  outputFlushLimit?: number
  frameBudget?: number
  flushDelay?: number
  write: (chunk: string, done?: () => void) => void
  onWrite?: () => void
  onMetrics?: (raw: string, outputLength: number, backlogLength: number) => void
  onBackpressure?: (level: 'high' | 'normal', backlog: number) => void
}

export function useTerminalOutputScheduler({
  fastOutputLimit = DEFAULT_FAST_OUTPUT_LIMIT,
  outputFlushLimit = DEFAULT_OUTPUT_FLUSH_LIMIT,
  frameBudget = DEFAULT_FRAME_BUDGET,
  flushDelay = 4,
  write,
  onWrite,
  onMetrics,
  onBackpressure,
}: UseTerminalOutputSchedulerOptions) {
  const bufferRef = useRef('')
  const frameRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backpressureRef = useRef<'high' | 'normal'>('normal')
  const writingRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  const emitBackpressure = useCallback((level: 'high' | 'normal', backlog: number) => {
    if (backpressureRef.current === level) return
    backpressureRef.current = level
    onBackpressure?.(level, backlog)
  }, [onBackpressure])
  const flush = useCallback(() => {
    frameRef.current = null
    if (!bufferRef.current || writingRef.current) return
    const chunk = bufferRef.current.slice(0, frameBudget)
    bufferRef.current = bufferRef.current.slice(chunk.length)
    writingRef.current = true
    write(chunk, () => {
      writingRef.current = false
      onWrite?.()
      if (bufferRef.current.length >= BACKPRESSURE_HIGH_WATERMARK) emitBackpressure('high', bufferRef.current.length)
      else if (bufferRef.current.length <= BACKPRESSURE_LOW_WATERMARK) emitBackpressure('normal', bufferRef.current.length)
      if (bufferRef.current.length) frameRef.current = requestAnimationFrame(flush)
    })
  }, [emitBackpressure, frameBudget, onWrite, write])
  const schedule = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(flush)
  }, [flush])
  const push = useCallback((raw: string) => {
    const output = raw
    onMetrics?.(raw, output.length, bufferRef.current.length)
    if (!output) return
    if (!bufferRef.current && !writingRef.current && output.length <= fastOutputLimit) {
      writingRef.current = true
      write(output, () => {
        writingRef.current = false
        onWrite?.()
        emitBackpressure('normal', 0)
        if (bufferRef.current.length) schedule()
      })
      return
    }
    bufferRef.current += output
    if (bufferRef.current.length >= outputFlushLimit) {
      clearTimer()
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      flush()
      return
    }
    schedule()
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (!frameRef.current) flush()
      }, flushDelay)
    }
    if (bufferRef.current.length >= BACKPRESSURE_HIGH_WATERMARK) emitBackpressure('high', bufferRef.current.length)
  }, [clearTimer, emitBackpressure, fastOutputLimit, flush, flushDelay, onMetrics, onWrite, outputFlushLimit, schedule, write])
  const dispose = useCallback(() => {
    clearTimer()
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    bufferRef.current = ''
    writingRef.current = false
    if (backpressureRef.current !== 'normal') {
      backpressureRef.current = 'normal'
      onBackpressure?.('normal', 0)
    }
  }, [clearTimer, onBackpressure])
  const getBacklog = useCallback(() => bufferRef.current.length, [])
  return { push, flush, dispose, getBacklog }
}
