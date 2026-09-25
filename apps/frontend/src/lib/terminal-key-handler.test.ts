import { describe, expect, it, vi } from 'vitest'
import { createTerminalKeyEventHandler } from './terminal-key-handler'

function makeHandler(selection = '') {
  const options = {
    getSelectionText: () => selection,
    runCopySelection: vi.fn(),
    scheduleKeyboardPasteFallback: vi.fn(),
    sendInput: vi.fn(),
    startDeleteWordRepeat: vi.fn(),
    isDeleteWordRepeatActive: () => false,
    focusTerminalInput: vi.fn(),
  }
  return { handler: createTerminalKeyEventHandler(options), options }
}

function ctrlC() {
  return new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })
}

describe('createTerminalKeyEventHandler', () => {
  it('lets a plain Ctrl+C through to the terminal when idle', () => {
    const { handler } = makeHandler()
    expect(handler(ctrlC())).toBe(true)
  })
  it('swallows a single Ctrl+C arriving right after a drag ends', () => {
    const { handler } = makeHandler()
    window.dispatchEvent(new Event('dragend'))
    expect(handler(ctrlC())).toBe(false)
    // 只吞一次,后续真实 Ctrl+C 不受影响
    expect(handler(ctrlC())).toBe(true)
  })
  it('still copies the selection on Ctrl+C even right after a drag ends', () => {
    const { handler, options } = makeHandler('sel')
    window.dispatchEvent(new Event('dragend'))
    expect(handler(ctrlC())).toBe(false)
    expect(options.runCopySelection).toHaveBeenCalledWith('sel', true, true, options.focusTerminalInput)
  })
})
