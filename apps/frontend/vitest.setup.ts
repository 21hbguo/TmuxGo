import '@testing-library/jest-dom/vitest'
import React from 'react'
import { act } from 'react-dom/test-utils'

if (!(React as typeof React & { act?: typeof act }).act) {
  ;(React as typeof React & { act?: typeof act }).act = act
}
if (typeof ResizeObserver === 'undefined') {
  ;(globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
}
