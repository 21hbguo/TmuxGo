export const STREAM_EVENT = {
  attached: 'attached',
  resized: 'resized',
  error: 'error',
  detached: 'detached',
  sessionExit: 'session-exit',
  reconnected: 'reconnected',
  agentStatus: 'agent-status',
  agentStatusSnapshot: 'agent-status-snapshot',
  agentStatusRemoved: 'agent-status-removed',
  agentNotification: 'agent-notification',
  agentMonitorError: 'agent-monitor-error',
} as const
export type StreamEventName = (typeof STREAM_EVENT)[keyof typeof STREAM_EVENT]
type StreamEventListener = (detail: any) => void
const listeners = new Map<string, Set<StreamEventListener>>()
export function emitStreamEvent(type: StreamEventName, detail?: any) {
  const set = listeners.get(type)
  if (!set) return
  for (const listener of [...set]) listener(detail)
}
export function subscribeStreamEvent(type: StreamEventName, listener: StreamEventListener) {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(type)
  }
}
