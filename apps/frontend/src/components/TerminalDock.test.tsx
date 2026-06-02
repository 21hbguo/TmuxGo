import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalDock } from './TerminalDock'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./WindowTabs', () => ({
  WindowTabs: () => React.createElement('div', null, 'tabs'),
}))
vi.mock('./PaneGrid', () => ({
  PaneGrid: () => React.createElement('div', null, 'grid'),
}))

describe('TerminalDock', () => {
  beforeEach(() => {
    useConsoleStore.setState({
      terminalPanelHeight: 300,
    } as any)
  })
  it('resizes against panel bottom instead of viewport bottom', () => {
    const { container } = render(<TerminalDock minHeight={180} maxHeight={540} dragViewportHeight={900} />)
    const section = container.querySelector('section') as HTMLElement
    const handle = container.querySelector('.cursor-row-resize') as HTMLElement
    expect(section).toBeTruthy()
    expect(handle).toBeTruthy()
    Object.defineProperty(section, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ bottom: 700 }),
    })
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientY: 500 })
    fireEvent.mouseUp(window)
    expect(useConsoleStore.getState().terminalPanelHeight).toBe(200)
  })
})
