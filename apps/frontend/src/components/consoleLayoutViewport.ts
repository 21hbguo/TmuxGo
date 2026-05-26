export function getViewportLayoutState({
  isMobileViewport,
  innerHeight,
  viewportHeight,
  viewportWidth,
  previousViewportWidth,
  baseHeight,
  keyboardOpen,
  keyboardInset,
  bodyKeyboardOpen,
}: {
  isMobileViewport: boolean
  innerHeight: number
  viewportHeight: number
  viewportWidth: number
  previousViewportWidth: number
  baseHeight: number
  keyboardOpen: boolean
  keyboardInset: number
  bodyKeyboardOpen: boolean
}) {
  const nextViewportWidth = Math.round(viewportWidth || 0)
  const widthChanged = previousViewportWidth !== nextViewportWidth
  let nextBaseHeight = widthChanged ? 0 : baseHeight
  if (isMobileViewport && viewportHeight && (!nextBaseHeight || viewportHeight > nextBaseHeight)) nextBaseHeight = viewportHeight
  const resolvedBaseHeight = nextBaseHeight || viewportHeight || innerHeight
  const viewportInset = viewportHeight ? Math.max(0, resolvedBaseHeight - viewportHeight) : 0
  const effectiveInset = Math.max(viewportInset, keyboardOpen ? keyboardInset : 0)
  const open = isMobileViewport && (effectiveInset >= 80 || keyboardOpen || bodyKeyboardOpen)
  const nextHeight = Math.round(!isMobileViewport ? innerHeight : open ? Math.max(0, resolvedBaseHeight - effectiveInset) : resolvedBaseHeight)
  return { viewportWidth: nextViewportWidth, baseHeight: nextBaseHeight, inset: open ? effectiveInset : 0, open, nextHeight }
}
