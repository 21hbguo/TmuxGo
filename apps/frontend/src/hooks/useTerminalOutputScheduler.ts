'use client'
import { useCallback, useRef } from 'react'

const DEFAULT_FAST_OUTPUT_LIMIT = 24576
const DEFAULT_FRAME_BUDGET = 32768
const DEFAULT_FRAME_TIME_BUDGET = 8
const MIN_FRAME_BUDGET = 4096
const DIRECT_WRITE_IDLE_MS = 0
const BACKPRESSURE_HIGH_WATERMARK = 65536
const BACKPRESSURE_LOW_WATERMARK = 8192
// 输出写屏障的上限：持续输出不能让等待方（如 resize 揭罩）无限挂起
const WRITE_BARRIER_TIMEOUT_MS = 160
const FRAME_END_SEQUENCE = '\u001b[?25h'
const MIN_FRAME_CUT = 256
const INCOMPLETE_ESCAPE_REGEX = /\u001b(?:\[[0-?]*[ -/]*|\][^\x07]*|\([ -~]*)?$/
function findFlushCut(buffer: string, limit: number) {
  if (buffer.length <= limit) return buffer.length
  const frameEnd = buffer.lastIndexOf(FRAME_END_SEQUENCE, limit)
  if (frameEnd >= MIN_FRAME_CUT) return frameEnd + FRAME_END_SEQUENCE.length
  let cut = limit
  const incomplete = INCOMPLETE_ESCAPE_REGEX.exec(buffer.slice(0, cut))
  if (incomplete && incomplete[0]) cut -= incomplete[0].length
  if (cut <= 0) cut = limit
  if (buffer.charCodeAt(cut - 1) >= 0xd800 && buffer.charCodeAt(cut - 1) <= 0xdbff) cut -= 1
  return Math.max(1, cut)
}

interface UseTerminalOutputSchedulerOptions {
  fastOutputLimit?: number
  outputFlushLimit?: number
  frameBudget?: number
  frameTimeBudget?: number
  flushDelay?: number
  write: (chunk: string, done?: () => void) => void
  onWrite?: () => void
  onMetrics?: (raw: string, outputLength: number, backlogLength: number) => void
  onBackpressure?: (level: 'high' | 'normal', backlog: number) => void
}

export function useTerminalOutputScheduler({
  fastOutputLimit = DEFAULT_FAST_OUTPUT_LIMIT,
  frameBudget = DEFAULT_FRAME_BUDGET,
  frameTimeBudget = DEFAULT_FRAME_TIME_BUDGET,
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
  const writeTokenRef = useRef(0)
  const scheduleRef = useRef<() => void>(() => {})
  const flushRef = useRef<() => void>(() => {})
  const adaptiveFrameBudgetRef = useRef(frameBudget)
  const lastPushAtRef = useRef(Number.NEGATIVE_INFINITY)
  const writeBarriersRef = useRef<Array<() => void>>([])
  const resolveWriteBarriers = useCallback(() => {
    const pending = writeBarriersRef.current
    if (!pending.length) return
    writeBarriersRef.current = []
    for (const cb of pending) cb()
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  const emitBackpressure = useCallback(
    (level: 'high' | 'normal', backlog: number) => {
      if (backpressureRef.current === level) return
      backpressureRef.current = level
      onBackpressure?.(level, backlog)
    },
    [onBackpressure],
  )
  const flush = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    clearTimer()
    if (!bufferRef.current || writingRef.current) return
    const cut = findFlushCut(bufferRef.current, Math.min(frameBudget, adaptiveFrameBudgetRef.current))
    const chunk = bufferRef.current.slice(0, cut)
    bufferRef.current = bufferRef.current.slice(cut)
    writingRef.current = true
    const writeToken = ++writeTokenRef.current
    const startedAt = performance.now()
    write(chunk, () => {
      if (writeToken !== writeTokenRef.current) return
      writingRef.current = false
      const elapsed = performance.now() - startedAt
      if (elapsed > frameTimeBudget && adaptiveFrameBudgetRef.current > MIN_FRAME_BUDGET)
        adaptiveFrameBudgetRef.current = Math.max(MIN_FRAME_BUDGET, Math.floor(adaptiveFrameBudgetRef.current / 2))
      else if (elapsed < frameTimeBudget / 2 && adaptiveFrameBudgetRef.current < frameBudget)
        adaptiveFrameBudgetRef.current = Math.min(frameBudget, Math.floor(adaptiveFrameBudgetRef.current * 1.5))
      onWrite?.()
      const backlog = bufferRef.current.length
      if (backlog >= BACKPRESSURE_HIGH_WATERMARK) emitBackpressure('high', backlog)
      else if (backlog <= BACKPRESSURE_LOW_WATERMARK) emitBackpressure('normal', backlog)
      if (backlog) flushRef.current()
      else resolveWriteBarriers()
    })
  }, [clearTimer, emitBackpressure, frameBudget, frameTimeBudget, onWrite, resolveWriteBarriers, write])
  flushRef.current = flush
  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    const frame = requestAnimationFrame(() => {
      frameRef.current = null
      clearTimer()
      flush()
    })
    frameRef.current = frame
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current)
          frameRef.current = null
        }
        flush()
      }, flushDelay)
    }
  }, [clearTimer, flush, flushDelay])
  scheduleRef.current = schedule
  const push = useCallback(
    (raw: string) => {
      const output = raw
      onMetrics?.(raw, output.length, bufferRef.current.length)
      if (!output) return
      const now = performance.now()
      const directWrite =
        !bufferRef.current &&
        !writingRef.current &&
        now - lastPushAtRef.current >= DIRECT_WRITE_IDLE_MS &&
        output.length <= fastOutputLimit
      lastPushAtRef.current = now
      if (directWrite) {
        writingRef.current = true
        const writeToken = ++writeTokenRef.current
        const startedAt = performance.now()
        write(output, () => {
          if (writeToken !== writeTokenRef.current) return
          writingRef.current = false
          const elapsed = performance.now() - startedAt
          if (elapsed > frameTimeBudget && adaptiveFrameBudgetRef.current > MIN_FRAME_BUDGET)
            adaptiveFrameBudgetRef.current = Math.max(MIN_FRAME_BUDGET, Math.floor(adaptiveFrameBudgetRef.current / 2))
          else if (elapsed < frameTimeBudget / 2 && adaptiveFrameBudgetRef.current < frameBudget)
            adaptiveFrameBudgetRef.current = Math.min(frameBudget, Math.floor(adaptiveFrameBudgetRef.current * 1.5))
          onWrite?.()
          const backlog = bufferRef.current.length
          if (backlog >= BACKPRESSURE_HIGH_WATERMARK) emitBackpressure('high', backlog)
          else if (backlog <= BACKPRESSURE_LOW_WATERMARK) emitBackpressure('normal', backlog)
          if (backlog) flushRef.current()
          else resolveWriteBarriers()
        })
        return
      }
      bufferRef.current += output
      if (bufferRef.current.length >= BACKPRESSURE_HIGH_WATERMARK) emitBackpressure('high', bufferRef.current.length)
      scheduleRef.current()
    },
    [emitBackpressure, fastOutputLimit, frameBudget, frameTimeBudget, onMetrics, onWrite, resolveWriteBarriers, write],
  )
  // 写屏障：等已进 scheduler 的输出（backlog + 在途 write 回调）全部落屏后回调。
  // WebSocket 上 output 先于 resized 到达，但 xterm.write 是异步解析——
  // 只认消息顺序会让旧列宽帧闪进新网格；持续输出时用超时封顶，不能无限挂起
  const afterWrites = useCallback(
    (cb: () => void) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        writeBarriersRef.current = writeBarriersRef.current.filter((item) => item !== finish)
        cb()
      }
      const timer = setTimeout(finish, WRITE_BARRIER_TIMEOUT_MS)
      if (!writingRef.current && !bufferRef.current) {
        finish()
        return
      }
      writeBarriersRef.current.push(finish)
      flush()
    },
    [flush],
  )
  const dispose = useCallback(() => {
    clearTimer()
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    writeTokenRef.current += 1
    bufferRef.current = ''
    writingRef.current = false
    adaptiveFrameBudgetRef.current = frameBudget
    lastPushAtRef.current = Number.NEGATIVE_INFINITY
    resolveWriteBarriers()
    if (backpressureRef.current !== 'normal') {
      backpressureRef.current = 'normal'
      onBackpressure?.('normal', 0)
    }
  }, [clearTimer, frameBudget, onBackpressure, resolveWriteBarriers])
  const getBacklog = useCallback(() => bufferRef.current.length, [])
  return { push, flush, dispose, getBacklog, afterWrites }
}
