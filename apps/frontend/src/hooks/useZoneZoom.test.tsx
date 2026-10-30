import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useZoneZoom } from './useZoneZoom'
import { useEditorViewPrefs } from '@/lib/editor-view-prefs'
import { DEFAULT_WORKSPACE_ZOOM, useWorkspaceZoom } from '@/lib/workspace-zoom'

function Harness() {
  useZoneZoom()
  return (
    <>
      <div data-editor-pane>
        <div data-testid="editor" tabIndex={0} />
      </div>
      <div data-terminal-pane>
        <div data-testid="terminal" tabIndex={0} />
      </div>
      <div data-testid="ui" tabIndex={0} />
    </>
  )
}

describe('useZoneZoom', () => {
  beforeEach(() => {
    useEditorViewPrefs.setState({ fontScale: 1 })
    useWorkspaceZoom.setState({ ...DEFAULT_WORKSPACE_ZOOM })
  })

  it('routes Ctrl+wheel by pointer zone without touching the other two', () => {
    render(<Harness />)
    fireEvent.wheel(screen.getByTestId('editor'), { ctrlKey: true, deltaY: -100 })
    expect(useEditorViewPrefs.getState().fontScale).toBe(1.1)
    expect(useWorkspaceZoom.getState()).toMatchObject({ terminalScale: 1, uiScale: 1 })

    fireEvent.wheel(screen.getByTestId('terminal'), { ctrlKey: true, deltaY: -100 })
    expect(useWorkspaceZoom.getState().terminalScale).toBe(1.1)
    expect(useEditorViewPrefs.getState().fontScale).toBe(1.1)
    expect(useWorkspaceZoom.getState().uiScale).toBe(1)

    fireEvent.wheel(screen.getByTestId('ui'), { ctrlKey: true, deltaY: -100 })
    expect(useWorkspaceZoom.getState().uiScale).toBe(1.1)
    expect(useWorkspaceZoom.getState().terminalScale).toBe(1.1)
    expect(useEditorViewPrefs.getState().fontScale).toBe(1.1)
  })

  it('routes Ctrl+plus/minus/0 by focused zone', () => {
    render(<Harness />)
    screen.getByTestId('terminal').focus()
    fireEvent.keyDown(screen.getByTestId('terminal'), { key: '+', ctrlKey: true, shiftKey: true })
    expect(useWorkspaceZoom.getState().terminalScale).toBe(1.1)
    expect(useEditorViewPrefs.getState().fontScale).toBe(1)

    screen.getByTestId('ui').focus()
    fireEvent.keyDown(screen.getByTestId('ui'), { key: '-', ctrlKey: true })
    expect(useWorkspaceZoom.getState().uiScale).toBe(0.9)
    fireEvent.keyDown(screen.getByTestId('ui'), { key: '0', ctrlKey: true })
    expect(useWorkspaceZoom.getState().uiScale).toBe(1)

    screen.getByTestId('editor').focus()
    fireEvent.keyDown(screen.getByTestId('editor'), { key: '=', ctrlKey: true })
    expect(useEditorViewPrefs.getState().fontScale).toBe(1.1)
  })

  it('prevents browser zoom while accumulating trackpad-sized deltas', () => {
    render(<Harness />)
    const ui = screen.getByTestId('ui')
    const first = fireEvent.wheel(ui, { ctrlKey: true, deltaY: -8 })
    expect(first).toBe(false) // preventDefault
    expect(useWorkspaceZoom.getState().uiScale).toBe(1)
    fireEvent.wheel(ui, { ctrlKey: true, deltaY: -8 })
    fireEvent.wheel(ui, { ctrlKey: true, deltaY: -8 })
    fireEvent.wheel(ui, { ctrlKey: true, deltaY: -8 })
    fireEvent.wheel(ui, { ctrlKey: true, deltaY: -8 })
    expect(useWorkspaceZoom.getState().uiScale).toBe(1.1)
  })
})
