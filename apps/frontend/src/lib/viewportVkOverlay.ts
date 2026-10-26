// Experimental overlaysContent evidence channel (G2-vk).
//
// Background: on the field Edge device the bottom URL bar is pushed up by the
// keyboard and visualViewport.height under-reports by ~138 CSS px. Overlay mode
// (navigator.virtualKeyboard.overlaysContent = true) stops the visual viewport
// from shrinking, so we can compare the raw virtual-keyboard rect against a
// bottom estimate derived from it.
//
// This changes viewport behaviour by design, so it only ever turns on behind an
// explicit flag: ?vk-overlay=1 or localStorage['tmuxgo-vk-overlay'] = '1'.
// Mount sets the property, unmount (or flag off) restores the previous value.
// Everything else here is read-only sampling.
//
// Coordinate space warning: Android Chrome/Edge report boundingRect in a space
// that does not line up with CSS pixels of the layout viewport — y/top/bottom
// carry a chrome offset, which is why vkRectTop must never be compared to
// innerHeight directly. Height is the comparatively trustworthy value during
// steady state (it overshoots during the open animation, recorded raw).
// vkBottomEst therefore starts from screen.height (stable, physical) and
// subtracts height and a session-calibrated URL-bar estimate.
import { recordMobileDiagnostic } from './mobile-diagnostics'

export type VkRectRaw = {
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  top: number | null
  bottom: number | null
}

type VirtualKeyboardWithRect = {
  overlaysContent?: boolean
  boundingRect?: { x?: number; y?: number; width?: number; height?: number; top?: number; bottom?: number } | null
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

const VK_OVERLAY_STORAGE_KEY = 'tmuxgo-vk-overlay'
const VK_OVERLAY_QUERY = 'vk-overlay'

function getVirtualKeyboard(): VirtualKeyboardWithRect | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardWithRect }).virtualKeyboard
}

// Two entry points on purpose: a query parameter survives a cold reload on a
// device without devtools, and localStorage lets a remote debug session turn it
// on without touching the URL.
export function isVkOverlayRequested(
  search: string | undefined = typeof window !== 'undefined' ? window.location.search : undefined,
  storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined,
): boolean {
  const params = new URLSearchParams(search ?? '')
  if (params.get(VK_OVERLAY_QUERY) === '1') return true
  try {
    return storage?.getItem(VK_OVERLAY_STORAGE_KEY) === '1'
  } catch {
    // Private mode / blocked storage: treat as off rather than throwing.
    return false
  }
}

export function isVkOverlayActive(): boolean {
  return getVirtualKeyboard()?.overlaysContent === true
}

// Applies overlay mode and returns a restore function that puts back whatever
// value the browser had before (the reference implementation for this trick
// does the same in a mount effect).
export function applyVkOverlay(enabled: boolean): () => void {
  const vk = getVirtualKeyboard()
  if (!vk || !enabled) return () => {}
  const hadOwn = Object.prototype.hasOwnProperty.call(vk, 'overlaysContent')
  const previous = vk.overlaysContent
  try {
    vk.overlaysContent = true
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (hadOwn || previous !== undefined) vk.overlaysContent = previous
      else delete vk.overlaysContent
    } catch {
      // Non-configurable property: leave it on rather than crash the unmount.
    }
  }
}

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function readVkRect(): VkRectRaw {
  const rect = getVirtualKeyboard()?.boundingRect
  return {
    x: asNumber(rect?.x),
    y: asNumber(rect?.y),
    width: asNumber(rect?.width),
    height: asNumber(rect?.height),
    top: asNumber(rect?.top),
    bottom: asNumber(rect?.bottom),
  }
}

// URL-bar estimate = max - min of innerHeight while the keyboard is closed.
// Toolbar collapse/expand changes the layout viewport height (field device:
// 710 ⇄ 658, so 52), and that difference is exactly the URL-bar band we cannot
// otherwise measure. Only closed samples count: with the keyboard open the
// height is already consumed by the keyboard inset.
export class UrlbarCalibrator {
  private min: number | null = null
  private max: number | null = null

  observe(innerHeight: number, keyboardOpen: boolean): void {
    if (keyboardOpen || !Number.isFinite(innerHeight)) return
    this.min = this.min === null ? innerHeight : Math.min(this.min, innerHeight)
    this.max = this.max === null ? innerHeight : Math.max(this.max, innerHeight)
  }

  get estimate(): number | null {
    if (this.min === null || this.max === null) return null
    return Math.round(this.max - this.min)
  }

  reset(): void {
    this.min = null
    this.max = null
  }
}

// geometrychange fires on every keyboard frame, so the animation shows up as a
// burst of overshooting rects. We record them raw; anyone reading the series can
// see the overshoot instead of having it smoothed away.
export type VkGeometrySampler = { dispose(): void }

export function createVkGeometrySampler(options: { vk?: VirtualKeyboardWithRect | undefined } = {}): VkGeometrySampler {
  const vk = options.vk ?? getVirtualKeyboard()
  if (!vk?.addEventListener) return { dispose: () => {} }
  const handler = () => {
    const rect = readVkRect()
    recordMobileDiagnostic('viewport-vk-geometry', {
      ...rect,
      overlaysContent: vk.overlaysContent === true,
      innerHeight: typeof window !== 'undefined' ? window.innerHeight : null,
      vvHeight: typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.height : null,
    })
  }
  vk.addEventListener('geometrychange', handler)
  return {
    dispose() {
      vk.removeEventListener?.('geometrychange', handler)
    },
  }
}

// Bottom estimate for the keyboard edge, in screen coordinates.
export function estimateVkBottom(
  rectHeight: number | null,
  screenHeight: number | null,
  urlbarEst: number | null,
): number | null {
  if (rectHeight === null || screenHeight === null || urlbarEst === null) return null
  return Math.round(screenHeight - rectHeight - urlbarEst)
}
