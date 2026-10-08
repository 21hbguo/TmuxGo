import { describe, expect, it } from 'vitest'
import { createTerminalPaneInteractions, isSgrMouseButtonPress } from './terminal-pane-interactions'

describe('isSgrMouseButtonPress', () => {
  it('detects left-button press reports', () => {
    expect(isSgrMouseButtonPress('\x1b[<0;41;40M')).toBe(true)
    // modifier bits (4/8/16) still map to MouseDown1Pane in tmux
    expect(isSgrMouseButtonPress('\x1b[<8;41;40M')).toBe(true)
    expect(isSgrMouseButtonPress('\x1b[<16;41;40M')).toBe(true)
    expect(isSgrMouseButtonPress('\x1b[<28;41;40M')).toBe(true)
  })

  it('rejects release, motion, wheel and other buttons', () => {
    expect(isSgrMouseButtonPress('\x1b[<0;41;40m')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<1;41;40M')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<2;41;40M')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<32;41;40M')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<35;41;40M')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<64;41;40M')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<65;41;40M')).toBe(false)
  })

  it('rejects non-mouse input', () => {
    expect(isSgrMouseButtonPress('a')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[A')).toBe(false)
    expect(isSgrMouseButtonPress('')).toBe(false)
    expect(isSgrMouseButtonPress('\x1b[<0;41;40Mextra')).toBe(false)
  })
})

describe('createTerminalPaneInteractions', () => {
  const makeInteractions = (snapshot: any) =>
    createTerminalPaneInteractions(
      () => null,
      document.createElement('div'),
      () => snapshot,
    )

  it('resolves a cell to the pane containing it', () => {
    const interactions = makeInteractions({
      activeWindowId: 'w1',
      activePaneId: 'p1',
      windows: [{ id: 'w1', active: true }],
      panes: [
        { id: 'p1', windowId: 'w1', left: 0, top: 0, size: { cols: 100, rows: 30 } },
        { id: 'p2', windowId: 'w1', left: 0, top: 31, size: { cols: 100, rows: 14 } },
      ],
    })
    expect(interactions.getPaneIdByMouseCell({ x: 40, y: 38 })).toBe('p2')
    expect(interactions.getPaneIdByMouseCell({ x: 40, y: 10 })).toBe('p1')
  })
})
