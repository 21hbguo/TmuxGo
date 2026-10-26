import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumePendingTerminalFocus, peekPendingTerminalFocus, requestTerminalFocus } from './terminal-focus-request'

function clearPending() {
  consumePendingTerminalFocus('local', 'main')
}

describe('terminal focus request handoff', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearPending()
  })

  it('peeks without burning the request so a failed focus can retry', () => {
    requestTerminalFocus('local', 'main')
    expect(peekPendingTerminalFocus('local', 'main')).toBe(true)
    // 组字中/换帧中第一次聚焦会落空：挂单必须留着给重试
    expect(peekPendingTerminalFocus('local', 'main')).toBe(true)
    expect(consumePendingTerminalFocus('local', 'main')).toBe(true)
    expect(peekPendingTerminalFocus('local', 'main')).toBe(false)
    expect(consumePendingTerminalFocus('local', 'main')).toBe(false)
  })

  it('only matches the exact host + session', () => {
    requestTerminalFocus('local', 'main')
    expect(peekPendingTerminalFocus('local', 'other')).toBe(false)
    expect(peekPendingTerminalFocus('remote', 'main')).toBe(false)
    expect(consumePendingTerminalFocus('remote', 'main')).toBe(false)
    expect(peekPendingTerminalFocus('local', 'main')).toBe(true)
  })

  it('expires after the ttl', () => {
    vi.useFakeTimers()
    requestTerminalFocus('local', 'main')
    vi.advanceTimersByTime(5_001)
    expect(peekPendingTerminalFocus('local', 'main')).toBe(false)
    expect(consumePendingTerminalFocus('local', 'main')).toBe(false)
  })
})
