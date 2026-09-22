// Client-side WS packet counters over a rolling 60s window (60 one-second
// ring buckets; stale buckets are skipped on read and overwritten on write).
// TCP hides real packet loss, so loss is measured at the app layer: a ping
// whose pong never arrives (timeout, socket close, or connection reset
// while still pending) counts as lost.
const WINDOW_BUCKETS = 60

function makeWindow() {
  const counts = new Array<number>(WINDOW_BUCKETS).fill(0)
  const secs = new Array<number>(WINDOW_BUCKETS).fill(-1)
  return {
    add(nowMs: number) {
      const sec = Math.floor(nowMs / 1000)
      const i = sec % WINDOW_BUCKETS
      if (secs[i] !== sec) {
        secs[i] = sec
        counts[i] = 0
      }
      counts[i] += 1
    },
    sum(nowMs: number) {
      const cutoff = Math.floor(nowMs / 1000) - (WINDOW_BUCKETS - 1)
      let n = 0
      for (let i = 0; i < WINDOW_BUCKETS; i++) if (secs[i] >= cutoff) n += counts[i]
      return n
    },
    clear() {
      counts.fill(0)
      secs.fill(-1)
    },
  }
}

export type NetStats = {
  tx: number
  rx: number
  pingSent: number
  pingLost: number
  lossPct: number
}

const txWin = makeWindow()
const rxWin = makeWindow()
const pingSentWin = makeWindow()
const pingLostWin = makeWindow()
let pendingPings = 0

export function netStatsTx() {
  txWin.add(Date.now())
}

export function netStatsRx() {
  rxWin.add(Date.now())
}

export function netStatsPingSent() {
  pingSentWin.add(Date.now())
  pendingPings += 1
}

export function netStatsPong() {
  if (pendingPings > 0) pendingPings -= 1
}

// Pongs can no longer arrive for these pings; count them as lost.
export function netStatsFlushPending() {
  while (pendingPings > 0) {
    pingLostWin.add(Date.now())
    pendingPings -= 1
  }
}

export function netStatsReset() {
  txWin.clear()
  rxWin.clear()
  pingSentWin.clear()
  pingLostWin.clear()
  pendingPings = 0
}

export function getNetStats(): NetStats {
  const now = Date.now()
  const pingSent = pingSentWin.sum(now)
  const pingLost = pingLostWin.sum(now)
  return {
    tx: txWin.sum(now),
    rx: rxWin.sum(now),
    pingSent,
    pingLost,
    lossPct: pingSent > 0 ? (pingLost / pingSent) * 100 : 0,
  }
}
