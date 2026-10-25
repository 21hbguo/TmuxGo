// Sanitized viewport traces for the mobile layout state machine.
//
// Sanitization: only event kinds and geometry numbers are kept. ua / sessionId /
// host / path / ip are stripped. Local device: 365x769 portrait (iPhone-ish).
//
// Source: real-device capture `tmuxgo-mobile-debug.ndjson` (read-only). Times are
// local wall clock; the dispatch brief quotes the same segment in UTC (04:26–04:39
// UTC == 12:26–12:39 local, 2026-10-25).
//
// Each step is one `viewport-sync` sample — i.e. exactly what ConsoleLayout feeds
// into getNextViewportStableState() / getViewportLayoutState().
export type ViewportTraceStep = {
  /** Sample time (performance.now, raw trace value; monotonic within a fixture). */
  at: number
  /** window.innerHeight */
  innerHeight: number
  /** visualViewport.height */
  vvHeight: number
  /** visualViewport.width */
  vvWidth: number
  /** keyboardStateRef.current.open — DOM keyboard-open/close already processed. */
  keyboardOpen: boolean
  /** document.body.classList.contains('keyboard-open') */
  bodyKeyboardOpen: boolean
  /** keyboardStateRef.current.inset */
  keyboardInset: number
  /** document.body.classList.contains('ime-composing') — sample is computed but not applied. */
  imeComposing?: boolean
}

export type ViewportTraceFixture = {
  name: string
  /** Trace window the fixture was cut from (sanitized: date + time only). */
  source: string
  // The 12:38 build carried the "closed shell must not exceed the visible region"
  // clamp (see design.md incident chain); the 12:27 build did not. The clamp is what
  // pushes the applied appHeight down to the shrunken vv height before the keyboard
  // flag lands, so it is part of the replay contract, not an accident.
  closedClamp: boolean
  /** app-height recorded by the app after each step (unchanged value = frame skipped). */
  recordedAppHeights: number[]
  steps: ViewportTraceStep[]
}

// vv shrinks to 446 while the keyboard flag lags, the clamped closed shell applies
// 446, then the open flag lands on an already-shrunk appHeight: 446 - 322 = 124.
// Same shape repeats twice, and keyboard close never restores the 769 baseline.
export const collapseTraceFixture: ViewportTraceFixture = {
  name: 'collapsed-vv-then-flag',
  source: '2026-10-25 12:38:05–12:38:12 (04:38 UTC)',
  closedClamp: true,
  recordedAppHeights: [769, 446, 124, 446, 124, 446],
  steps: [
    {
      at: 523,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 2181,
      innerHeight: 768,
      vvHeight: 446.2757263183594,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 2455,
      innerHeight: 768,
      vvHeight: 446.2757263183594,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 322.2820739746094,
    },
    {
      at: 3338,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 4848,
      innerHeight: 768,
      vvHeight: 446.2757263183594,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 322.2820739746094,
    },
    {
      at: 5438,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
  ],
}

// 开→关 完整周期，同一台设备、无夹紧的旧构建：抠住开键前的可见高度不缩水，
// 开键盘得到 446，关键盘回到 769。今天的行为是对的，作为回归基线。
export const normalCycleTraceFixture: ViewportTraceFixture = {
  name: 'open-close-cycle',
  source: '2026-10-25 12:26:50–12:27:10 (04:27 UTC)',
  closedClamp: false,
  recordedAppHeights: [769, 769, 446, 769],
  steps: [
    {
      at: 513,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 19109,
      innerHeight: 768,
      vvHeight: 446.2757263183594,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 19418,
      innerHeight: 768,
      vvHeight: 446.2757263183594,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 322.2820739746094,
    },
    {
      at: 20066,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
  ],
}

// IME window: keyboard already open at 459, then composition starts and updates.
// The trace shows no geometry change while composing (that is the observed fact);
// the replay pins that composition edits leave the applied height and the closed
// baseline alone.
export const compositionTraceFixture: ViewportTraceFixture = {
  name: 'ime-composition',
  source: '2026-10-21 12:37:23–12:38:10',
  closedClamp: false,
  recordedAppHeights: [769, 769, 459, 459, 459],
  steps: [
    {
      at: 641,
      innerHeight: 768,
      vvHeight: 768.5578002929688,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 28270,
      innerHeight: 768,
      vvHeight: 459.20758056640625,
      vvWidth: 365.13470458984375,
      keyboardOpen: false,
      bodyKeyboardOpen: false,
      keyboardInset: 0,
    },
    {
      at: 28599,
      innerHeight: 768,
      vvHeight: 459.20758056640625,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 309.3502197265625,
    },
    {
      at: 47281,
      innerHeight: 768,
      vvHeight: 459.20758056640625,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 309.3502197265625,
      imeComposing: true,
    },
    {
      at: 47690,
      innerHeight: 768,
      vvHeight: 459.20758056640625,
      vvWidth: 365.13470458984375,
      keyboardOpen: true,
      bodyKeyboardOpen: true,
      keyboardInset: 309.3502197265625,
      imeComposing: true,
    },
  ],
}

export const viewportTraceFixtures = [collapseTraceFixture, normalCycleTraceFixture, compositionTraceFixture] as const
