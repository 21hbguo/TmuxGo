import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchEditorCommand,
  isEditorCommandAvailable,
  registerEditorCommandHandler,
  resetEditorCommandBus,
  subscribeEditorCommandAvailability,
} from './editor-command-bus'

describe('editor command bus', () => {
  afterEach(() => resetEditorCommandBus())

  it('reports availability until a handler registers', () => {
    expect(isEditorCommandAvailable()).toBe(false)
    expect(dispatchEditorCommand('save')).toBe(false)
    const dispose = registerEditorCommandHandler(vi.fn())
    expect(isEditorCommandAvailable()).toBe(true)
    expect(dispatchEditorCommand('save')).toBe(true)
    dispose()
    expect(isEditorCommandAvailable()).toBe(false)
  })

  it('forwards the command id to the handler', () => {
    const handler = vi.fn()
    registerEditorCommandHandler(handler)
    dispatchEditorCommand('goto-symbol')
    expect(handler).toHaveBeenCalledWith('goto-symbol')
  })

  it('notifies availability listeners on register and unregister', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEditorCommandAvailability(listener)
    const dispose = registerEditorCommandHandler(vi.fn())
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registerEditorCommandHandler(vi.fn())
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the newest handler when an older one is disposed', () => {
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = registerEditorCommandHandler(first)
    registerEditorCommandHandler(second)
    // 旧工作台的清理不得把新工作台的 handler 摘掉
    disposeFirst()
    expect(isEditorCommandAvailable()).toBe(true)
    dispatchEditorCommand('close')
    expect(second).toHaveBeenCalledWith('close')
    expect(first).not.toHaveBeenCalled()
  })
})
