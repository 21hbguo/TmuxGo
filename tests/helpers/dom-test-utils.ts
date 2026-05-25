import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

export function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const { window } = dom
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    localStorage: window.localStorage,
  })
  return dom
}

export function render(element: React.ReactElement) {
  const container = document.getElementById('root')
  if (!container) throw new Error('Missing root container')
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return {
    root,
    container,
    unmount() {
      act(() => {
        root.unmount()
      })
    },
  }
}

export async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

export function click(element: Element) {
  act(() => {
    ;(element as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

export function keydown(element: Element, options: KeyboardEventInit) {
  act(() => {
    ;(element as HTMLElement).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...options }))
  })
}
