import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasModalLayerOpen, popKeyLayer, pushKeyLayer } from './modal-layers'

function keydown(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function modalLayer(handlers: { onEscape?: () => void; onEnter?: () => void } = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const id = pushKeyLayer({ getEl: () => el, ...handlers })
  return {
    id,
    el,
    dispose: () => {
      popKeyLayer(id)
      el.remove()
    },
  }
}

describe('modal-layers dispatcher', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('routes Escape to the topmost layer only and swallows it', () => {
    const below = vi.fn()
    const top = vi.fn()
    const lower = pushKeyLayer({ onEscape: below })
    const upper = pushKeyLayer({ onEscape: top })
    const event = keydown(document.body, { key: 'Escape' })
    expect(top).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    popKeyLayer(upper)
    popKeyLayer(lower)
  })

  it('swallows bare keys targeted outside a modal layer', () => {
    const terminal = document.createElement('textarea')
    document.body.appendChild(terminal)
    terminal.focus()
    const layer = modalLayer()
    const event = keydown(terminal, { key: 'a' })
    expect(event.defaultPrevented).toBe(true)
    layer.dispose()
  })

  it('routes Enter outside the modal to onEnter instead of the background', () => {
    const terminal = document.createElement('textarea')
    document.body.appendChild(terminal)
    terminal.focus()
    const onEnter = vi.fn()
    const layer = modalLayer({ onEnter })
    const event = keydown(terminal, { key: 'Enter' })
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    layer.dispose()
    terminal.remove()
  })

  it('fires onEnter for Enter on non-interactive surface inside the modal', () => {
    const onEnter = vi.fn()
    const layer = modalLayer({ onEnter })
    const region = document.createElement('div')
    layer.el.appendChild(region)
    region.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onEnter).toHaveBeenCalledTimes(1)
    layer.dispose()
  })

  it('leaves Enter on inputs/buttons inside the modal to the control itself', () => {
    const onEnter = vi.fn()
    const layer = modalLayer({ onEnter })
    const input = document.createElement('input')
    const button = document.createElement('button')
    layer.el.append(input, button)
    const inputEvent = keydown(input, { key: 'Enter' })
    const buttonEvent = keydown(button, { key: 'Enter' })
    expect(onEnter).not.toHaveBeenCalled()
    expect(inputEvent.defaultPrevented).toBe(false)
    expect(buttonEvent.defaultPrevented).toBe(false)
    layer.dispose()
  })

  it('lets Shift+Enter through untouched', () => {
    const onEnter = vi.fn()
    const layer = modalLayer({ onEnter })
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const event = keydown(textarea, { key: 'Enter', shiftKey: true })
    expect(onEnter).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true) // 弹窗外仍拦停，但不触发主操作
    layer.dispose()
    textarea.remove()
  })

  it('does not swallow modifier combos targeted outside', () => {
    const layer = modalLayer()
    const event = keydown(document.body, { key: 'r', ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    layer.dispose()
  })

  it('keys targeted inside the modal pass through normally', () => {
    const layer = modalLayer()
    const inner = document.createElement('div')
    layer.el.appendChild(inner)
    const event = keydown(inner, { key: 'x' })
    expect(event.defaultPrevented).toBe(false)
    layer.dispose()
  })

  it('nested modal: keys targeted inside the lower modal are treated as outside', () => {
    const lower = modalLayer()
    const upper = modalLayer()
    const lowerButton = document.createElement('button')
    lower.el.appendChild(lowerButton)
    const event = keydown(lowerButton, { key: 'k' })
    expect(event.defaultPrevented).toBe(true)
    upper.dispose()
    lower.dispose()
  })

  it('hasModalLayerOpen reflects modal registration only', () => {
    expect(hasModalLayerOpen()).toBe(false)
    const escOnly = pushKeyLayer({ onEscape: () => {} })
    expect(hasModalLayerOpen()).toBe(false)
    const layer = modalLayer()
    expect(hasModalLayerOpen()).toBe(true)
    layer.dispose()
    popKeyLayer(escOnly)
    expect(hasModalLayerOpen()).toBe(false)
  })
})
