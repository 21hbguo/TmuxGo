import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

test('fluency telemetry remains available during repeated output sampling', async ({ page, request }) => {
  const name = `tmuxgo_fluency_${Date.now()}`
  const session = await ensureSession(request, name)
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
    for (let i = 0; i < 30; i += 1) {
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: `printf "fluency_${i}\\n"` } }))
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: '\r' } }))
    }
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: 'for i in $(seq 1 900); do printf "fluency_bulk_%04d abcdefghijklmnopqrstuvwxyz\\n" "$i"; done' } }))
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: '\r' } }))
  })
  await page.waitForTimeout(1200)
  const telemetry = await page.evaluate(async () => {
    const responsive = await new Promise((resolve) => requestAnimationFrame(() => resolve(true)))
    const sys = await fetch('http://127.0.0.1:3001/api/system').then((res) => res.json())
    const text = document.body.innerText
    const perf = text.includes('WS ') && text.includes('FL ') && text.includes('ATT ')
    return { sys, perf, responsive }
  })
  expect(telemetry.perf).toBeTruthy()
  expect(telemetry.responsive).toBeTruthy()
  expect(telemetry.sys.stream.outputFlushes).toBeGreaterThan(0)
  expect(telemetry.sys.stream.outputBytes).toBeGreaterThan(0)
  expect(telemetry.sys.stream.activeFlushInterval).toBeGreaterThan(0)
  expect(typeof telemetry.sys.stream.backpressureSignals).toBe('number')
  expect(typeof telemetry.sys.stream.socketBufferedBytes).toBe('number')
  expect(typeof telemetry.sys.stream.deferredFlushes).toBe('number')
})
