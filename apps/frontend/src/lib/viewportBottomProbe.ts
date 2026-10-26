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
//   painted there. A non-root element means the point is actually visible; the
//   html/body root is what browsers return for "nothing is there", i.e. covered.
//   How keyboard areas answer varies per vendor — that is exactly what we
//   measure, so every hit/miss is recorded rather than inferred.
// - IntersectionObserver v2 trackVisibility has a >=100ms delay by spec, so it
//   could only validate steady state, not animations; elementFromPoint is
//   synchronous and cheap enough for every tick, so it ships first.
// - navigator.virtualKeyboard.boundingRect has a known chrome-offset bug in
//   its y/top/bottom, but its height is comparatively trustworthy (it overshoots
//   during animation). We record the raw values, unrounded semantics included.
import { recordMobileDiagnostic } from './mobile-diagnostics'

type VirtualKeyboardLike = {
  // Read-only on purpose: never assign overlaysContent from here.
  overlaysContent?: boolean
  boundingRect?: { x?: number; y?: number; width?: number; height?: number } | null
}

export type BottomProbeSample = {
  // Max y (CSS px) proven visible below vv.bottom; null = method unavailable.
  probeVisibleBottom: number | null
  // Compact hit list: "y:1" = element hit, "y:0" = covered (null or root).
  probeHits: string
  // Reference value: vv.height + vv.offsetTop.
  vvBottom: number | null
  // probeVisibleBottom - vvBottom; the Edge dead band shows up as ~+138.
  vvVsProbeDelta: number | null
  vkRectHeight: number | null
  vkRectTop: number | null
  innerHeight: number
  vvHeight: number | null
  probeMethod: 'elementFromPoint' | 'none' | 'budget'
  // Wall time spent probing this tick; kept to prove the cost is ignorable.
  probeCostMs: number
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
}

const DEFAULT_STEP_PX = 24
const DEFAULT_START_GAP_PX = 8
const DEFAULT_EDGE_PX = 8
const DEFAULT_MAX_POINTS = 8
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

const round1 = (value: number) => Math.round(value * 10) / 10

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
  const rect = keyboard?.boundingRect ?? null
  const base = {
    innerHeight: Math.round(input.innerHeight),
    vvHeight: input.vv ? round1(input.vv.height) : null,
    vvBottom,
    vkRectHeight: rect && typeof rect.height === 'number' ? round1(rect.height) : null,
    vkRectTop: rect && typeof rect.y === 'number' ? round1(rect.y) : null,
  }
  const cost = () => round1(clock() - started)

  // Without a visual viewport (or without hit testing) there is nothing to
  // compare against; report the absence instead of inventing a bottom.
  if (vvBottom === null || !doc || typeof doc.elementFromPoint !== 'function')
    return {
      ...base,
      probeVisibleBottom: null,
      probeHits: '',
      vvVsProbeDelta: null,
      probeMethod: 'none',
      probeCostMs: cost(),
    }

  const hits: string[] = []
  let visibleBottom = Math.min(vvBottom, base.innerHeight)
  for (let y = vvBottom + startGapPx; y <= base.innerHeight - edgePx && hits.length < maxPoints; y += stepPx) {
    if (clock() - started > budgetMs)
      return {
        ...base,
        probeVisibleBottom: null,
        probeHits: hits.join(';'),
        vvVsProbeDelta: null,
        probeMethod: 'budget',
        probeCostMs: cost(),
      }
    const sampleY = Math.round(y)
    let hit = 0
    try {
      const el = doc.elementFromPoint(PROBE_X, sampleY)
      // Root means "nothing painted here" (covered by chrome/keyboard).
      if (el && !ROOT_TAGS.has(el.tagName)) hit = 1
    } catch {
      hit = 0
    }
    hits.push(`${sampleY}:${hit}`)
    if (hit) visibleBottom = sampleY
  }

  return {
    ...base,
    probeVisibleBottom: visibleBottom,
    probeHits: hits.join(';'),
    vvVsProbeDelta: round1(visibleBottom - vvBottom),
    probeMethod: 'elementFromPoint',
    probeCostMs: cost(),
  }
}

export type BottomProbeRunner = {
  // Returns the sample when this tick was probed, null when gated off.
  tick(input: BottomProbeInput): BottomProbeSample | null
  reset(): void
}

export function createViewportBottomProbeRunner(options: BottomProbeOptions = {}): BottomProbeRunner {
  const gate = options.gate ?? new ViewportBottomProbeGate()
  const record =
    options.record ?? ((sample: BottomProbeSample) => recordMobileDiagnostic('viewport-bottom-probe', { ...sample }))
  return {
    tick(input) {
      const vvHeight = input.vv ? input.vv.height : null
      if (!gate.shouldRun({ mobile: input.mobile, keyboardOpen: input.keyboardOpen, vvHeight })) return null
      try {
        const sample = probeBottomEdge(input, options)
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
  sharedRunner?.reset()
  sharedRunner = null
}
