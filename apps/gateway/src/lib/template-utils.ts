export interface SessionTemplateLayout {
  windows: {
    name: string
    panes: { command?: string }[]
    splitDirection?: 'horizontal' | 'vertical'
    layoutPreset?: 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical'
  }[]
}

export function getTemplateWindowTargets(sessionName: string, layout: SessionTemplateLayout, startIndex = 0) {
  return layout.windows.map((windowDef, index) => ({
    index,
    windowTarget: `${sessionName}:${startIndex + index}`,
    panes: windowDef.panes?.length ? windowDef.panes : [{}],
    name: windowDef.name,
    splitDirection: windowDef.splitDirection,
    layoutPreset: windowDef.layoutPreset,
  }))
}

export function getNormalizedWindowMoves(sessionName: string, orderedWindowIds: string[], offset = 1000) {
  return [
    ...orderedWindowIds.map((windowId, index) => ({ source: windowId, target: `${sessionName}:${offset + index}` })),
    ...orderedWindowIds.map((_, index) => ({ source: `${sessionName}:${offset + index}`, target: `${sessionName}:${index}` })),
  ]
}
