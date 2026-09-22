import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getNetStats,
  netStatsFlushPending,
  netStatsPingSent,
  netStatsPong,
  netStatsReset,
  netStatsRx,
  netStatsTx,
} from './net-stats'

describe('net-stats', () => {
  beforeEach(() => {
    netStatsReset()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('counts tx and rx packets', () => {
    netStatsTx()
    netStatsTx()
    netStatsRx()
    const s = getNetStats()
    expect(s.tx).toBe(2)
    expect(s.rx).toBe(1)
    expect(s.lossPct).toBe(0)
  })

  it('drops events older than 60s from the window', () => {
    netStatsTx()
    netStatsRx()
    vi.setSystemTime(1_000_000 + 61_000)
    const s = getNetStats()
    expect(s.tx).toBe(0)
    expect(s.rx).toBe(0)
  })

  it('keeps recent events while expiring old ones', () => {
    netStatsTx()
    vi.setSystemTime(1_000_000 + 59_000)
    netStatsTx()
    vi.setSystemTime(1_000_000 + 61_000)
    expect(getNetStats().tx).toBe(1)
  })

  it('reports 0% loss when all pings are acked', () => {
    netStatsPingSent()
    netStatsPingSent()
    netStatsPong()
    netStatsPong()
    expect(getNetStats().lossPct).toBe(0)
  })

  it('counts pending pings as lost on flush', () => {
    netStatsPingSent()
    netStatsPingSent()
    netStatsPingSent()
    netStatsPong()
    netStatsFlushPending()
    const s = getNetStats()
    expect(s.pingLost).toBe(2)
    expect(s.lossPct).toBeCloseTo(66.7, 1)
  })

  it('expires loss from the window', () => {
    netStatsPingSent()
    netStatsFlushPending()
    vi.setSystemTime(1_000_000 + 61_000)
    expect(getNetStats().lossPct).toBe(0)
  })

  it('ignores extra pongs and repeated flushes', () => {
    netStatsPong()
    netStatsPingSent()
    netStatsFlushPending()
    netStatsFlushPending()
    expect(getNetStats().pingLost).toBe(1)
  })

  it('resets all counters', () => {
    netStatsTx()
    netStatsPingSent()
    netStatsFlushPending()
    netStatsReset()
    const s = getNetStats()
    expect(s.tx).toBe(0)
    expect(s.pingSent).toBe(0)
    expect(s.pingLost).toBe(0)
    expect(s.lossPct).toBe(0)
  })
})
