export type NetCounters = { sentBytes: number; recvBytes: number }
export type NetWindowStats = NetCounters & {
  daySentBytes: number
  dayRecvBytes: number
  last24hSentBytes: number
  last24hRecvBytes: number
  trackedMs: number
  windowMs: number
}
type NetSample = NetCounters & { t: number }
type HostNetState = {
  dayKey: string
  dayBaseline: NetCounters
  samples: NetSample[]
}
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SAMPLES = 24 * 60
const MIN_SAMPLE_GAP_MS = 30_000
const hostStates = new Map<string, HostNetState>()
function dayKeyAt(now: number) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
function safeBytes(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}
function deltaBytes(current: number, base: number) {
  if (!Number.isFinite(current) || current < 0) return 0
  if (!Number.isFinite(base) || base < 0) return current
  return current >= base ? current - base : current
}
function createState(_hostId: string, counters: NetCounters, now: number): HostNetState {
  const sentBytes = safeBytes(counters.sentBytes)
  const recvBytes = safeBytes(counters.recvBytes)
  const sample = { t: now, sentBytes, recvBytes }
  return {
    dayKey: dayKeyAt(now),
    dayBaseline: { sentBytes, recvBytes },
    samples: [sample],
  }
}
function pushSample(state: HostNetState, counters: NetCounters, now: number) {
  const sentBytes = safeBytes(counters.sentBytes)
  const recvBytes = safeBytes(counters.recvBytes)
  const last = state.samples[state.samples.length - 1]
  if (last && now - last.t < MIN_SAMPLE_GAP_MS) {
    last.t = now
    last.sentBytes = sentBytes
    last.recvBytes = recvBytes
    return
  }
  state.samples.push({ t: now, sentBytes, recvBytes })
  if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES)
}
function findBaselineForWindow(state: HostNetState, now: number, windowMs: number): NetSample {
  const cutoff = now - windowMs
  let baseline = state.samples[0]
  for (const sample of state.samples) {
    if (sample.t <= cutoff) baseline = sample
    else break
  }
  return baseline
}
export function observeNetWindow(hostId: string, counters: NetCounters, now = Date.now()): NetWindowStats {
  const sentBytes = safeBytes(counters.sentBytes)
  const recvBytes = safeBytes(counters.recvBytes)
  let state = hostStates.get(hostId)
  if (!state) {
    state = createState(hostId, { sentBytes, recvBytes }, now)
    hostStates.set(hostId, state)
  } else {
    const last = state.samples[state.samples.length - 1]
    if (last && (sentBytes < last.sentBytes || recvBytes < last.recvBytes)) {
      state = createState(hostId, { sentBytes, recvBytes }, now)
      hostStates.set(hostId, state)
    } else {
      const key = dayKeyAt(now)
      if (state.dayKey !== key) {
        state.dayKey = key
        state.dayBaseline = { sentBytes, recvBytes }
      }
      pushSample(state, { sentBytes, recvBytes }, now)
    }
  }
  const first = state.samples[0]
  const windowBase = findBaselineForWindow(state, now, DAY_MS)
  return {
    sentBytes,
    recvBytes,
    daySentBytes: deltaBytes(sentBytes, state.dayBaseline.sentBytes),
    dayRecvBytes: deltaBytes(recvBytes, state.dayBaseline.recvBytes),
    last24hSentBytes: deltaBytes(sentBytes, windowBase.sentBytes),
    last24hRecvBytes: deltaBytes(recvBytes, windowBase.recvBytes),
    trackedMs: Math.max(0, now - first.t),
    windowMs: Math.min(DAY_MS, Math.max(0, now - windowBase.t)),
  }
}
export function resetNetWindowState() {
  hostStates.clear()
}
