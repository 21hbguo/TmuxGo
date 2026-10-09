import { describe, expect, it } from 'vitest'
import {
  isOutsideWindowStrip,
  isTerminalDockDrag,
  setTerminalDockDragActive,
  TERMINAL_DOCK_DRAG_MIME,
} from './terminal-dock-drag'

const STRIP = { left: 100, right: 900, top: 20, bottom: 50 }

describe('isTerminalDockDrag', () => {
  it('recognizes the module flag without relying on dataTransfer contents', () => {
    setTerminalDockDragActive(true)
    expect(isTerminalDockDrag(null)).toBe(true)
    setTerminalDockDragActive(false)
    expect(isTerminalDockDrag(null)).toBe(false)
  })
  it('recognizes the dock mime in dataTransfer.types', () => {
    setTerminalDockDragActive(false)
    expect(isTerminalDockDrag({ types: [TERMINAL_DOCK_DRAG_MIME] } as unknown as DataTransfer)).toBe(true)
    expect(isTerminalDockDrag({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
  })
})

describe('isOutsideWindowStrip', () => {
  it('treats a missing strip as outside so zones can still show', () => {
    expect(isOutsideWindowStrip(null, 0, 0)).toBe(true)
  })
  it('stays inside within the strip rect plus hysteresis', () => {
    expect(isOutsideWindowStrip(STRIP, 500, 35)).toBe(false)
    expect(isOutsideWindowStrip(STRIP, 500, 57)).toBe(false) // bottom+7 仍在滞回带内
    expect(isOutsideWindowStrip(STRIP, 500, 13)).toBe(false) // top-7
  })
  it('is outside beyond the hysteresis band or horizontally off the strip', () => {
    expect(isOutsideWindowStrip(STRIP, 500, 59)).toBe(true) // bottom+9
    expect(isOutsideWindowStrip(STRIP, 500, 11)).toBe(true)
    expect(isOutsideWindowStrip(STRIP, 50, 35)).toBe(true)
    expect(isOutsideWindowStrip(STRIP, 950, 35)).toBe(true)
  })
})
