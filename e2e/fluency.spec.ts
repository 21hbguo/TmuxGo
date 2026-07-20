import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

test('fluency telemetry remains available during repeated output sampling', async ({ page, request }) => {
  const name = `tmuxgo_fluency_${Date.now()}`
  const session = await ensureSession(request, name)
  const baselineResponse = await request.get('http://127.0.0.1:3001/api/system')
  const baseline = await baselineResponse.json()
  await openSession(page, session)
  await page.waitForFunction(() => {
    const text = document.body.innerText
    return !text.includes('没有打开的窗口') && !text.includes('No open window')
  }, undefined, { timeout: 15000 })
  await page.waitForFunction(() => {
    const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    return !!t?.cols && !!t?.rows
  }, undefined, { timeout: 15000 })
  await page.evaluate(() => {
    const target = window as typeof window & { __tmuxgoFluency?: { frames: number; longTasks: number; maxFrameGap: number; maxLongTask: number; stop: boolean; observer?: PerformanceObserver } }
    const state = { frames: 0, longTasks: 0, maxFrameGap: 0, maxLongTask: 0, stop: false, observer: undefined as PerformanceObserver | undefined }
    let lastFrame = performance.now()
    const tick = (now: number) => {
      state.frames += 1
      state.maxFrameGap = Math.max(state.maxFrameGap, now - lastFrame)
      lastFrame = now
      if (!state.stop) requestAnimationFrame(tick)
    }
    if (typeof PerformanceObserver !== 'undefined') {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks += 1
          state.maxLongTask = Math.max(state.maxLongTask, entry.duration)
        }
      })
      try {
        state.observer.observe({ entryTypes: ['longtask'] })
      } catch {}
    }
    target.__tmuxgoFluency = state
    requestAnimationFrame(tick)
    for (let i = 0; i < 30; i += 1) {
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: `printf "fluency_${i}\\n"` } }))
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: '\r' } }))
    }
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: 'for i in $(seq 1 900); do printf "fluency_bulk_%04d abcdefghijklmnopqrstuvwxyz\\n" "$i"; done' } }))
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: '\r' } }))
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: 'printf "__TMUXGO_FLUENCY_DONE__\\n"' } }))
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: '\r' } }))
  })
  await page.waitForFunction(() => {
    const terminal = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    const buffer = terminal?.buffer?.active
    if (!buffer) return false
    for (let index = Math.max(0, buffer.length - 120); index < buffer.length; index += 1) {
      if (buffer.getLine(index)?.translateToString(true).includes('__TMUXGO_FLUENCY_DONE__')) return true
    }
    return false
  }, undefined, { timeout: 15000 })
  await page.waitForTimeout(200)
  const telemetry = await page.evaluate(async () => {
    const state = (window as typeof window & { __tmuxgoFluency?: { frames: number; longTasks: number; maxFrameGap: number; maxLongTask: number; stop: boolean; observer?: PerformanceObserver } }).__tmuxgoFluency
    if (state) {
      state.stop = true
      state.observer?.disconnect()
    }
    const sys = await fetch('http://127.0.0.1:3001/api/system').then((res) => res.json())
    return { sys, frames: state?.frames || 0, longTasks: state?.longTasks || 0, maxFrameGap: state?.maxFrameGap || 0, maxLongTask: state?.maxLongTask || 0 }
  })
  expect(telemetry.frames).toBeGreaterThan(5)
  expect(telemetry.maxFrameGap).toBeLessThan(250)
  expect(telemetry.longTasks).toBeLessThanOrEqual(5)
  expect(telemetry.maxLongTask).toBeLessThan(250)
  expect(telemetry.sys.stream.attachRequests - baseline.stream.attachRequests).toBeLessThanOrEqual(4)
  expect(telemetry.sys.stream.snapshotRequests - baseline.stream.snapshotRequests).toBeLessThanOrEqual(12)
  expect(telemetry.sys.stream.outputFlushes - baseline.stream.outputFlushes).toBeGreaterThan(0)
  expect(telemetry.sys.stream.outputBytes - baseline.stream.outputBytes).toBeGreaterThan(0)
  expect(telemetry.sys.stream.activeFlushInterval).toBeGreaterThan(0)
  expect(typeof telemetry.sys.stream.backpressureSignals).toBe('number')
  expect(typeof telemetry.sys.stream.socketBufferedBytes).toBe('number')
  expect(typeof telemetry.sys.stream.deferredFlushes).toBe('number')
})
