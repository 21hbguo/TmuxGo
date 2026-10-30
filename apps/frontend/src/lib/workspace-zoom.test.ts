import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ZOOM, sanitizeWorkspaceZoom, useWorkspaceZoom } from './workspace-zoom'
import { useEditorViewPrefs } from './editor-view-prefs'

describe('workspace zoom', () => {
  beforeEach(() => {
    useWorkspaceZoom.setState({ ...DEFAULT_WORKSPACE_ZOOM })
    useEditorViewPrefs.setState({ fontScale: 1 })
  })

  it('keeps terminal and UI scales independent', () => {
    const store = useWorkspaceZoom.getState()
    store.zoomTerminal(1)
    expect(useWorkspaceZoom.getState().terminalScale).toBe(1.1)
    expect(useWorkspaceZoom.getState().uiScale).toBe(1)
    store.zoomUi(-1)
    expect(useWorkspaceZoom.getState().terminalScale).toBe(1.1)
    expect(useWorkspaceZoom.getState().uiScale).toBe(0.9)
    expect(useEditorViewPrefs.getState().fontScale).toBe(1)
  })

  it('clamps and sanitizes persisted values', () => {
    expect(sanitizeWorkspaceZoom({ terminalScale: 99, uiScale: 0.1 })).toEqual({ terminalScale: 2, uiScale: 0.8 })
    expect(sanitizeWorkspaceZoom({ terminalScale: 'bad', uiScale: null })).toEqual({ terminalScale: 1, uiScale: 1 })
    expect(sanitizeWorkspaceZoom(null)).toEqual({ terminalScale: 1, uiScale: 1 })
  })

  it('resets one zone without touching the other', () => {
    useWorkspaceZoom.setState({ terminalScale: 1.4, uiScale: 1.6 })
    useWorkspaceZoom.getState().resetTerminal()
    expect(useWorkspaceZoom.getState()).toMatchObject({ terminalScale: 1, uiScale: 1.6 })
    useWorkspaceZoom.getState().resetUi()
    expect(useWorkspaceZoom.getState()).toMatchObject({ terminalScale: 1, uiScale: 1 })
  })
})
