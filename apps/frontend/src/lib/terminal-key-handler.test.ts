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

function ctrlV(type: 'keydown' | 'keyup') {
  return new KeyboardEvent(type, { key: 'v', ctrlKey: true })
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
  it('arms the paste fallback only on the Ctrl+V keydown', () => {
    const { handler, options } = makeHandler()
    expect(handler(ctrlV('keydown'))).toBe(false)
    expect(options.scheduleKeyboardPasteFallback).toHaveBeenCalledTimes(1)
  })
  it('does not re-arm the paste fallback on the Ctrl+V keyup', () => {
    const { handler, options } = makeHandler()
    handler(ctrlV('keydown'))
    // xterm 对 keyup 也回调本 handler；'v' 弹起时 ctrlKey 仍为 true
    expect(handler(ctrlV('keyup'))).toBe(true)
    expect(options.scheduleKeyboardPasteFallback).toHaveBeenCalledTimes(1)
  })
})
