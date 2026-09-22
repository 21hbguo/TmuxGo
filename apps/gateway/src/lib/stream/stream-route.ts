// Per-connection session dictionary for compact stream frames (version=2).
// Maps hostId+sessionName to a u16 route index. Index 0 is reserved as invalid.
export const STREAM_ROUTE_INVALID = 0
export const STREAM_ROUTE_MAX = 0xffff

export interface StreamRouteEntry {
  routeIdx: number
  hostId: string
  sessionName: string
}

function routeKey(hostId: string, sessionName: string) {
  return `${hostId}\0${sessionName}`
}

export class StreamRouteDictionary {
  private byKey = new Map<string, number>()
  private byIdx = new Map<number, StreamRouteEntry>()
  private nextIdx = 1

  /** Get or assign a stable route index. Returns null when the table is full. */
  assign(hostId: string, sessionName: string): number | null {
    const key = routeKey(hostId, sessionName)
    const existing = this.byKey.get(key)
    if (existing !== undefined) return existing
    if (this.nextIdx > STREAM_ROUTE_MAX) return null
    const routeIdx = this.nextIdx++
    this.byKey.set(key, routeIdx)
    this.byIdx.set(routeIdx, { routeIdx, hostId, sessionName })
    return routeIdx
  }

  lookup(hostId: string, sessionName: string): number | null {
    return this.byKey.get(routeKey(hostId, sessionName)) ?? null
  }

  resolve(routeIdx: number): StreamRouteEntry | null {
    if (!Number.isInteger(routeIdx) || routeIdx <= STREAM_ROUTE_INVALID) return null
    return this.byIdx.get(routeIdx) ?? null
  }

  entries(): StreamRouteEntry[] {
    return [...this.byIdx.values()].sort((a, b) => a.routeIdx - b.routeIdx)
  }

  clear() {
    this.byKey.clear()
    this.byIdx.clear()
    this.nextIdx = 1
  }

  get size() {
    return this.byIdx.size
  }
}
