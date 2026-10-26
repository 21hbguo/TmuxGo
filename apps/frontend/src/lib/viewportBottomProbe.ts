// Read-only bottom-edge probe (G1, evidence channel only).
//
// Field observation (2026-10-26): Edge/Android with the bottom URL bar pushed
// up by the keyboard reports visualViewport.height ~138 CSS px short. The model
// follows vv exactly, so the shell stops above a band that is actually
// paintable. The platform is wrong, not the model — before changing any source
// of truth (G2) we collect evidence about which signal tells the truth.
//
// Hard rule: this module never feeds layout. It only reads and reports.
// - It does NOT set navigator.virtualKeyboard.overlaysContent (that changes
//   viewport behaviour globally; we only read raw values).
// - It only calls document.elementFromPoint (pure read), no DOM writes.
// - Its output goes to mobile diagnostics and nowhere else.
//
// Probe method notes (non-obvious, kept here on purpose):
// - elementFromPoint hit-testing: we sample y below vv.bottom and ask what is
//   painted there. Two readings are kept, because they answer different
//   questions and the Edge dead band only shows up in the second one:
//     * probeVisibleBottom: max y returning a non-root element (real content).
//       A keyboard/chrome area can answer null or the root, so this is the
//       conservative "is app content painted here" reading.
//     * probeCanvasBottom: max y returning ANY element, root included. Browsers
//       answer with html/body where nothing else is painted, which is exactly
//       the "page canvas is visible but empty" case of the dead band. Treating
//       root hits as covered alone would report delta 0 and hide the bug.
//   Hit codes keep the identity instead of collapsing them: E = element,
//   B = html/body root, N = null. Vendor differences in keyboard areas are what
//   we measure, so every point is recorded verbatim.
// - IntersectionObserver v2 trackVisibility has a >=100ms delay by spec, so it
//   could only validate steady state, not animations; elementFromPoint is
//   synchronous and cheap enough for every tick, so it ships first.
// - navigator.virtualKeyboard.boundingRect has a known chrome-offset bug in
//   its y/top/bottom, but its height is comparatively trustworthy (it overshoots
//   during animation). We record the raw values, unrounded semantics included.
// - elementFromPoint turns out to be blind to chrome: on the field device the
//   whole 344→632 band answered body, URL bar and keyboard included, so canvas
//   bottom equals the layout bottom and cannot bound the real edge. The last
//   candidate is IntersectionObserver v2 trackVisibility, which asks the
//   compositor whether the element is actually visible (IME/URL-bar occlusion
//   included). Two 1px probes sit in the dead band and deep in the chrome area;
//   dead=true + deep=false would prove IO-v2 can binary-search the edge.
//   Spec delay is >=100ms, so it only describes steady state, never animations.
import { recordMobileDiagnostic } from './mobile-diagnostics'
import {
  createVkGeometrySampler,
  estimateVkBottom,
  isVkOverlayActive,
  readVkRect,
  UrlbarCalibrator,
  type VkGeometrySampler,
} from './viewportVkOverlay'

type VirtualKeyboardLike = {
  // Read here only; turning it on belongs to the flag-gated viewportVkOverlay.
  overlaysContent?: boolean
  boundingRect?: { x?: number; y?: number; width?: number; height?: number; top?: number; bottom?: number } | null
}

export type BottomProbeSample = {
  // Max y (CSS px) where real (non-root) content is painted below vv.bottom;
  // null = method unavailable.
  probeVisibleBottom: number | null
  // Max y where ANY element is painted, html/body included: "canvas visible but
  // empty" still counts. Delta 0 here means genuinely covered chrome.
  probeCanvasBottom: number | null
  // Compact hit list with hit identity: "y:E" element, "y:B" html/body root,
  // "y:N" null. Collapsing B and N would hide the dead band.
  probeHits: string
  // Reference value: vv.height + vv.offsetTop.
  vvBottom: number | null
  // probeVisibleBottom - vvBottom; the Edge dead band shows up as ~+138.
  vvVsProbeDelta: number | null
  // Raw virtual-keyboard rect, straight from the platform (top/bottom carry the
  // known chrome offset; recorded as-is).
  vkRectX: number | null
  vkRectY: number | null
  vkRectWidth: number | null
  vkRectHeight: number | null
  vkRectTop: number | null
  vkRectBottom: number | null
  // Estimated keyboard top derived from stable screen height, not from the
  // offset-buggy rect coordinates.
  vkBottomEst: number | null
  // Session-calibrated URL-bar height (max-min innerHeight while closed).
  urlbarEst: number | null
  vkOverlayEnabled: boolean
  innerHeight: number
  vvHeight: number | null
  probeMethod: 'elementFromPoint' | 'none' | 'budget'
  // Wall time spent probing this tick; kept to prove the cost is ignorable.
  probeCostMs: number
  // Platform chrome context for reading the numbers above (diagnostics only).
  screenHeight: number | null
  screenAvailHeight: number | null
  outerHeight: number | null
  // IO v2 trackVisibility readings: compositor-level visibility, not hit
  // testing. null = not measured yet / unsupported.
  iov2DeadBandVisible: boolean | null
  iov2DeepVisible: boolean | null
  iov2Supported: boolean
}

// IO v2 state as tracked by the probe elements; passed into each sample.
export type Iov2State = {
  deadBandVisible: boolean | null
  deepVisible: boolean | null
  supported: boolean
}

export type BottomProbeInput = {
  mobile: boolean
  keyboardOpen: boolean
  now: number
  vv: { height: number; offsetTop: number } | null
  innerHeight: number
  // Test seams; production uses the document navigator/globals.
  doc?: Document
  clock?: () => number
  getVirtualKeyboard?: () => VirtualKeyboardLike | undefined
  iov2?: Iov2State
  urlbarEst?: number | null
}

export type BottomProbeOptions = {
  stepPx?: number
  startGapPx?: number
  edgePx?: number
  maxPoints?: number
  budgetMs?: number
  record?: (sample: BottomProbeSample) => void
  gate?: ViewportBottomProbeGate
  clock?: () => number
  // Inject a prepared IO-v2 probe (tests) instead of creating one lazily.
  iov2?: Iov2Probe
}

const DEFAULT_STEP_PX = 24
const DEFAULT_START_GAP_PX = 8
const DEFAULT_EDGE_PX = 8
const DEFAULT_MAX_POINTS = 20
const DEFAULT_BUDGET_MS = 2
// How many ticks stay "hot" after a vv change, and the steady-state cadence.
const DEFAULT_HOT_TICKS = 15
const DEFAULT_STEADY_EVERY = 30

const ROOT_TAGS = new Set(['HTML', 'BODY'])
const PROBE_X = 4

function defaultClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function defaultVirtualKeyboard(): VirtualKeyboardLike | undefined {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard
}

// Screen/outer sizes are context, not truth: they tell us whether an N run is
// chrome (URL bar / OS nav) or the page really ended.
function readScreenMetrics(): {
  screenHeight: number | null
  screenAvailHeight: number | null
  outerHeight: number | null
} {
  const screens = typeof screen !== 'undefined' ? screen : undefined
  const outer = typeof window !== 'undefined' ? window.outerHeight : undefined
  return {
    screenHeight: screens && Number.isFinite(screens.height) ? Math.round(screens.height) : null,
    screenAvailHeight: screens && Number.isFinite(screens.availHeight) ? Math.round(screens.availHeight) : null,
    outerHeight: typeof outer === 'number' && Number.isFinite(outer) ? Math.round(outer) : null,
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10

const asFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? round1(value) : null

// Gate keeps the probe cheap: run while the keyboard is open or shortly after
// the visual viewport moved (animations settle in a few frames), and only on a
// slow cadence when everything is steady.
export class ViewportBottomProbeGate {
  private readonly hotTicks: number
  private readonly steadyEvery: number
  private tickCount = 0
  private hotUntil = 0
  private lastVvHeight: number | null = null

  constructor(hotTicks = DEFAULT_HOT_TICKS, steadyEvery = DEFAULT_STEADY_EVERY) {
    this.hotTicks = hotTicks
    this.steadyEvery = steadyEvery
  }

  shouldRun(input: Pick<BottomProbeInput, 'mobile' | 'keyboardOpen'> & { vvHeight: number | null }): boolean {
    if (!input.mobile) return false
    this.tickCount += 1
    if (input.vvHeight !== null && input.vvHeight !== this.lastVvHeight) this.hotUntil = this.tickCount + this.hotTicks
    this.lastVvHeight = input.vvHeight
    if (input.keyboardOpen) return true
    if (this.tickCount <= this.hotUntil) return true
    return this.tickCount % this.steadyEvery === 0
  }

  reset(): void {
    this.tickCount = 0
    this.hotUntil = 0
    this.lastVvHeight = null
  }
}

// One probe pass. Synchronous and read-only; aborts as soon as the time budget
// is exceeded and says so in probeMethod.
export function probeBottomEdge(input: BottomProbeInput, options: BottomProbeOptions = {}): BottomProbeSample {
  const clock = input.clock ?? options.clock ?? defaultClock
  const doc = input.doc ?? (typeof document !== 'undefined' ? document : null)
  const stepPx = options.stepPx ?? DEFAULT_STEP_PX
  const startGapPx = options.startGapPx ?? DEFAULT_START_GAP_PX
  const edgePx = options.edgePx ?? DEFAULT_EDGE_PX
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const started = clock()

  const vvBottom = input.vv ? round1(input.vv.height + input.vv.offsetTop) : null
  const keyboard = (input.getVirtualKeyboard ?? defaultVirtualKeyboard)()
  const rect = keyboard
    ? {
        x: asFinite(keyboard.boundingRect?.x),
        y: asFinite(keyboard.boundingRect?.y),
        width: asFinite(keyboard.boundingRect?.width),
        height: asFinite(keyboard.boundingRect?.height),
        top: asFinite(keyboard.boundingRect?.top),
        bottom: asFinite(keyboard.boundingRect?.bottom),
      }
    : readVkRect()
  const screenMetrics = readScreenMetrics()
  const urlbarEst = input.urlbarEst ?? null
  const base = {
    innerHeight: Math.round(input.innerHeight),
    vvHeight: input.vv ? round1(input.vv.height) : null,
    vvBottom,
    vkRectX: rect.x,
    vkRectY: rect.y,
    vkRectWidth: rect.width,
    vkRectHeight: rect.height,
    vkRectTop: rect.top,
    vkRectBottom: rect.bottom,
    vkBottomEst: estimateVkBottom(rect.height, screenMetrics.screenHeight, urlbarEst),
    urlbarEst,
    vkOverlayEnabled: keyboard ? keyboard.overlaysContent === true : isVkOverlayActive(),
    ...screenMetrics,
    iov2DeadBandVisible: input.iov2?.deadBandVisible ?? null,
    iov2DeepVisible: input.iov2?.deepVisible ?? null,
    iov2Supported: input.iov2?.supported ?? false,
  }
  const cost = () => round1(clock() - started)

  // Without a visual viewport (or without hit testing) there is nothing to
  // compare against; report the absence instead of inventing a bottom.
  if (vvBottom === null || !doc || typeof doc.elementFromPoint !== 'function')
    return {
      ...base,
      probeVisibleBottom: null,
      probeCanvasBottom: null,
      probeHits: '',
      vvVsProbeDelta: null,
      probeMethod: 'none',
      probeCostMs: cost(),
    }

  const hits: string[] = []
  const baseline = Math.min(vvBottom, base.innerHeight)
  let visibleBottom = baseline
  let canvasBottom = baseline
  // Adaptive descent: keep walking down until two consecutive misses. A single
  // N is not a boundary (a gap in content is possible); two in a row marks the
  // start of chrome or the true page end. Which of the two a browser reports
  // for the URL bar / keyboard is exactly what this probe is meant to answer.
  let consecutiveMisses = 0
  for (let y = vvBottom + startGapPx; y <= base.innerHeight - edgePx && hits.length < maxPoints; y += stepPx) {
    if (clock() - started > budgetMs)
      return {
        ...base,
        probeVisibleBottom: null,
        probeCanvasBottom: null,
        probeHits: hits.join(';'),
        vvVsProbeDelta: null,
        probeMethod: 'budget',
        probeCostMs: cost(),
      }
    const sampleY = Math.round(y)
    let code: 'N' | 'B' | 'E' = 'N'
    try {
      const el = doc.elementFromPoint(PROBE_X, sampleY)
      if (el) code = ROOT_TAGS.has(el.tagName) ? 'B' : 'E'
    } catch {
      code = 'N'
    }
    hits.push(`${sampleY}:${code}`)
    if (code !== 'N') canvasBottom = sampleY
    if (code === 'E') visibleBottom = sampleY
    consecutiveMisses = code === 'N' ? consecutiveMisses + 1 : 0
    if (consecutiveMisses >= 2) break
  }

  return {
    ...base,
    probeVisibleBottom: visibleBottom,
    probeCanvasBottom: canvasBottom,
    probeHits: hits.join(';'),
    vvVsProbeDelta: round1(visibleBottom - vvBottom),
    probeMethod: 'elementFromPoint',
    probeCostMs: cost(),
  }
}

// --- IO v2 (trackVisibility) route ---------------------------------------
// Two 1px fixed probes: one in the dead band (vv.bottom + 60) and one deep in
// the chrome area (innerHeight - 30). Dead visible + deep invisible proves the
// compositor sees the edge and IO-v2 can binary-search it; both true or both
// false means this route cannot decide and G2 must estimate instead.
const IOV2_DEAD_BAND_OFFSET_PX = 60
const IOV2_DEEP_OFFSET_PX = 30

type Iov2EntryLike = { isVisible?: boolean }
type Iov2ObserverLike = { observe(target: Element): void; disconnect(): void }
type Iov2ObserverCtor = new (
  callback: (entries: Iov2EntryLike[]) => void,
  options: { threshold?: number; trackVisibility?: boolean; delay?: number },
) => Iov2ObserverLike

export type Iov2Probe = {
  readonly state: Iov2State
  update(input: { vvBottom: number | null; innerHeight: number }): Iov2State
  dispose(): void
}

function isIov2Supported(ctor: unknown): boolean {
  if (typeof ctor !== 'function') return false
  // IO v2 ships as entry.isVisible; the init option alone is accepted silently
  // by browsers without the feature, so detect on the entry, not the options.
  const entryProto = typeof IntersectionObserverEntry !== 'undefined' ? IntersectionObserverEntry.prototype : null
  return !!entryProto && 'isVisible' in entryProto
}

function createProbeElement(doc: Document): HTMLElement {
  const el = doc.createElement('div')
  // opacity:0 would be reported as not visible; a nearly transparent fill is
  // required. pointer-events:none keeps the element out of hit testing, and
  // left:0 keeps it clear of the elementFromPoint column (x=4).
  el.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;background:rgba(0,0,0,0.01);pointer-events:none;z-index:-1;'
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('data-viewport-probe', '')
  return el
}

export function createIov2Probe(options: { doc?: Document; observerCtor?: Iov2ObserverCtor | null } = {}): Iov2Probe {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null)
  const ctor =
    options.observerCtor !== undefined
      ? options.observerCtor
      : (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  const state: Iov2State = { deadBandVisible: null, deepVisible: null, supported: isIov2Supported(ctor) }
  if (!doc || !state.supported) return { state, update: () => state, dispose: () => {} }

  const deadBand = createProbeElement(doc)
  const deep = createProbeElement(doc)
  const observer = new (ctor as Iov2ObserverCtor)(
    (entries) => {
      for (const entry of entries) {
        const el = (entry as unknown as { target: Element }).target
        // No isVisible key = the browser ignored trackVisibility; record
        // "unknown" instead of inventing false.
        const visible = typeof entry.isVisible === 'boolean' ? entry.isVisible : null
        if (el === deadBand) state.deadBandVisible = visible
        else if (el === deep) state.deepVisible = visible
      }
    },
    // delay is a spec minimum of 100ms: steady state only, never animations.
    { threshold: 0, trackVisibility: true, delay: 100 },
  )
  doc.body.append(deadBand, deep)
  observer.observe(deadBand)
  observer.observe(deep)

  return {
    state,
    update({ vvBottom, innerHeight }) {
      if (vvBottom !== null) deadBand.style.top = `${Math.round(vvBottom + IOV2_DEAD_BAND_OFFSET_PX)}px`
      deep.style.top = `${Math.round(innerHeight - IOV2_DEEP_OFFSET_PX)}px`
      return state
    },
    dispose() {
      observer.disconnect()
      deadBand.remove()
      deep.remove()
    },
  }
}

export type BottomProbeRunner = {
  // Returns the sample when this tick was probed, null when gated off.
  tick(input: BottomProbeInput): BottomProbeSample | null
  reset(): void
  dispose(): void
}

export function createViewportBottomProbeRunner(options: BottomProbeOptions = {}): BottomProbeRunner {
  const gate = options.gate ?? new ViewportBottomProbeGate()
  const record =
    options.record ?? ((sample: BottomProbeSample) => recordMobileDiagnostic('viewport-bottom-probe', { ...sample }))
  let iov2: Iov2Probe | null = null
  let geometry: VkGeometrySampler | null = null
  const calibrator = new UrlbarCalibrator()
  const ensureIov2 = (doc: Document | undefined): Iov2Probe => {
    iov2 ??= options.iov2 ?? createIov2Probe({ doc })
    return iov2
  }
  return {
    tick(input) {
      const vvHeight = input.vv ? input.vv.height : null
      if (!gate.shouldRun({ mobile: input.mobile, keyboardOpen: input.keyboardOpen, vvHeight })) return null
      try {
        const doc = input.doc ?? (typeof document !== 'undefined' ? document : undefined)
        const iov2State = ensureIov2(doc).update({
          vvBottom: input.vv ? input.vv.height + input.vv.offsetTop : null,
          innerHeight: input.innerHeight,
        })
        // geometrychange captures the open animation too, including overshoot.
        geometry ??= createVkGeometrySampler()
        calibrator.observe(input.innerHeight, input.keyboardOpen)
        const sample = probeBottomEdge({ ...input, iov2: iov2State, urlbarEst: calibrator.estimate }, options)
        record(sample)
        return sample
      } catch {
        // An evidence channel must never break the sync path.
        return null
      }
    },
    reset() {
      gate.reset()
    },
    dispose() {
      iov2?.dispose()
      iov2 = null
      geometry?.dispose()
      geometry = null
      calibrator.reset()
    },
  }
}

// Module-level singleton so the layout component only needs one call site.
let sharedRunner: BottomProbeRunner | null = null

export function maybeRecordViewportBottomProbe(input: BottomProbeInput): BottomProbeSample | null {
  sharedRunner ??= createViewportBottomProbeRunner()
  return sharedRunner.tick(input)
}

// Test seam: drop the shared gate/runner state between cases.
export function resetSharedBottomProbe(): void {
  sharedRunner?.dispose()
  sharedRunner = null
}
