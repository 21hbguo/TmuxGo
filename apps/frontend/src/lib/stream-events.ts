export const STREAM_EVENT = {
  attached: 'attached',
  resized: 'resized',
  windowSize: 'window-size',
  exclusiveRevoked: 'exclusive-revoked',
  resizeGesture: 'resize-gesture',
  error: 'error',
  detached: 'detached',
  sessionExit: 'session-exit',
  reconnected: 'reconnected',
  agentStatus: 'agent-status',
  agentStatusSnapshot: 'agent-status-snapshot',
  agentStatusRemoved: 'agent-status-removed',
  agentState: 'agent-state',
  agentFeedUnsupported: 'agent-feed-unsupported',
  agentNotification: 'agent-notification',
  agentMonitorError: 'agent-monitor-error',
  inboxMessageCreated: 'inbox-message-created',
  inboxMessageUpdated: 'inbox-message-updated',
  inboxMessageDeleted: 'inbox-message-deleted',
  inboxOpenTarget: 'inbox-open-target',
} as const
export type StreamEventName = (typeof STREAM_EVENT)[keyof typeof STREAM_EVENT]
// 各事件 detail 形状不一（attached/resized/inbox...），订阅方按各自载荷类型注册；
// 内部统一存 unknown 监听，注册处的窄化断言只在存储层生效，不改派发行为
type StreamEventListener = (detail: unknown) => void
const listeners = new Map<string, Set<StreamEventListener>>()
export function emitStreamEvent(type: StreamEventName, detail?: unknown) {
  const set = listeners.get(type)
  if (!set) return
  for (const listener of [...set]) listener(detail)
}
export function subscribeStreamEvent<T = Record<string, unknown>>(
  type: StreamEventName,
  listener: (detail: T) => void,
) {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(listener as StreamEventListener)
  return () => {
    set.delete(listener as StreamEventListener)
    if (!set.size) listeners.delete(type)
  }
}
