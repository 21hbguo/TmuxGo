'use client'
// Stage-2 shadow wiring: every legacy viewport sync tick feeds one observation
// into the new model and reports divergences. Compute-only — nothing here
// returns layout, mutates the shell, or dispatches events.
//
// The legacy path stays the single writer; this module is a tap on it. Every
// entry point is wrapped so a shadow failure can never reach the real path.
import { normalize } from '@/components/viewportModel'
import { sampleViewportObservation, ViewportEnvTracker } from '@/components/viewportObservation'
import {
  createViewportShadowRunner,
  type LegacyViewportOutput,
  type ViewportNormalizeFn,
  type ViewportShadowDiff,
  type ViewportShadowStats,
  type ViewportShadowRunner,
} from '@/components/viewportShadow'
import { recordViewportShadowDiff } from './mobile-diagnostics'

// Kill switch for field triage: `localStorage['tmuxgo-viewport-shadow'] = '0'`
// or `?viewport-shadow=0` disables the shadow without a deploy.
export const VIEWPORT_SHADOW_SWITCH_KEY = 'tmuxgo-viewport-shadow'
const SHADOW_SWITCH_OFF = '0'
// No real wake is useful beyond a couple of seconds; clamp so a stale model
// timestamp cannot park a long timer.
const MAX_WAKE_DELAY_MS = 2000

export function isViewportShadowEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem(VIEWPORT_SHADOW_SWITCH_KEY) === SHADOW_SWITCH_OFF) return false
    if (new URLSearchParams(window.location.search).get('viewport-shadow') === SHADOW_SWITCH_OFF) return false
    return true
  } catch {
    // Private-mode / blocked storage must not disable the shadow by accident.
    return true
  }
}

export type ViewportShadowTickInput = {
  now: number
  composition: boolean
  // Caller-owned gate (mobile viewport + kill switch); the wire never re-reads
  // matchMedia so tests can drive it deterministically.
  enabled: boolean
  legacy: LegacyViewportOutput
}

export type ViewportShadowWire = {
  tick(input: ViewportShadowTickInput): void
  readonly stats: ViewportShadowStats
}

export type ViewportShadowWireOptions = {
  onDiff?: (diff: ViewportShadowDiff) => void
  // Called when the model wants another sample (settle/grace deadlines).
  scheduleResample?: (delayMs: number) => void
  normalize?: ViewportNormalizeFn
  tracker?: ViewportEnvTracker
  runner?: ViewportShadowRunner
}

export function createViewportShadowWire(options: ViewportShadowWireOptions = {}): ViewportShadowWire {
  const tracker = options.tracker ?? new ViewportEnvTracker()
  const runner = options.runner ?? createViewportShadowRunner({ normalize: options.normalize ?? normalize })
  const onDiff = options.onDiff ?? recordViewportShadowDiff
  const scheduleResample = options.scheduleResample
  let warned = false

  return {
    tick({ now, composition, enabled, legacy }) {
      if (!enabled) return
      try {
        const envGen = tracker.sync()
        const observation = sampleViewportObservation({ now, composition, envGen })
        const diff = runner.tick(observation, legacy)
        if (diff) onDiff(diff)
        const wakeAt = runner.nextWakeAt
        if (wakeAt !== null && scheduleResample) {
          scheduleResample(Math.min(MAX_WAKE_DELAY_MS, Math.max(0, wakeAt - now)))
        }
      } catch (err) {
        // One warn per session: a broken shadow must not spam a phone console.
        if (!warned) {
          warned = true
          console.warn('[viewport-shadow] tick failed', err)
        }
      }
    },
    get stats() {
      return runner.stats
    },
  }
}
