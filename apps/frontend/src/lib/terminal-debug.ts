import { recordMobileDiagnostic } from './mobile-diagnostics'
import { recordImeDiagnostic } from './ime-diagnostics'
export function recordMobileDebug(event: string, data?: Record<string, unknown>) {
  recordMobileDiagnostic(event, data)
  if (typeof window === 'undefined' || !window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target = window as typeof window & { __tmuxgoMobileDebug?: { events: Array<Record<string, unknown>> } }
  const state = target.__tmuxgoMobileDebug || { events: [] }
  state.events.push({ event, at: Math.round(performance.now()), ...data })
  state.events = state.events.slice(-240)
  target.__tmuxgoMobileDebug = state
}
export function recordImeDebug(event: string, data?: Record<string, unknown>) {
  recordImeDiagnostic('terminal-pane', event, data)
}
