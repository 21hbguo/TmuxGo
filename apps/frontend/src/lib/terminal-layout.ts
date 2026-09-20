import { recordMobileDebug } from './terminal-debug'
const TERMINAL_REPAINT_DELAYS = [0, 16, 48, 120, 260]
const MOBILE_TERMINAL_REPAINT_DELAYS = [96]
const TERMINAL_RECOVERY_REPAINT_DELAYS = [0, 16, 64, 180]
const MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS = [48, 160]
const MOBILE_FIT_SIZE_TOLERANCE = 2
const DEVICE_PIXEL_RATIO_TOLERANCE = 0.01
// 连续拖动期间的中间 fit 间隔：等 2 个稳定帧的收敛检测会被拖动无限推迟，
// 需要节流推进让画面/远端尺寸跟上，又不能每帧全量 reflow
const DRAG_FIT_INTERVAL_MS = 140
interface TerminalLayoutOptions {
  container: HTMLElement
  isMobile: boolean
  getTerminal: () => any
  isDisposed: () => boolean
  preferencesRef: { current: any }
  attachExclusiveRef: { current: boolean }
  lastSizeRef: { current: { cols: number; rows: number } | null }
  sharedSessionSizeRef: { current: { cols: number; rows: number } | null }
  // 最近一次本地 fit 发起、尚未等到 resized/localOnly 确认的行列数；null=无在途 resize。
  // onResize 侧会合并后再实际发送，所以这里表示"已发起待确认"而非"已发送"；
  // 由 runtime 侧 handleResized 按尺寸匹配清零（ACK 不带代次，只能对最后发起值消歧）。
  // 可选：未接线的调用方退化为"永远无在途"，保持旧的即时揭开语义
  pendingRemoteResizeRef?: { current: { cols: number; rows: number } | null }
  onResizeRef: { current: ((cols: number, rows: number) => void) | undefined }
  // 每次真实容器尺寸变化（RO 观察步长，远密于节流后的 fit/onResize）都回调：
  // 供上层把远端 resize 的静止截止挂在真实拖动活动上，而不是稀疏 fit 通知
  onResizeActivityRef?: { current: (() => void) | undefined }
  controlCarryRef: { current: string }
  mask: {
    show: () => number
    reveal: (generation?: number) => void
    isVisible: () => boolean
  }
  // 揭罩屏障（runtime 注入）：等已排队输出写完再 reveal，缺省退化为直接 mask.reveal
  revealMask?: (generation?: number) => void
  getTerminalPerf: () => {
    attachLatency: number
    outputBytes: number
    outputEvents: number
    outputBacklog: number
    layoutFitCount: number
    lastOutputAt: string
  }
  updateTerminalPerf: (patch: Record<string, unknown>) => void
  notifyReady: () => void
  requestServerRedraw: () => void
}
export function createTerminalLayout(options: TerminalLayoutOptions) {
  const { container, isMobile: isMobileDevice, mask } = options
  const getTerminal = options.getTerminal
  const isDisposed = options.isDisposed
  const preferencesRef = options.preferencesRef
  const attachExclusiveRef = options.attachExclusiveRef
  const lastSizeRef = options.lastSizeRef
  const sharedSessionSizeRef = options.sharedSessionSizeRef
  const pendingRemoteResizeRef = options.pendingRemoteResizeRef ?? { current: null }
  const onResizeRef = options.onResizeRef
  const controlCarryRef = options.controlCarryRef
  const updateTerminalPerf = options.updateTerminalPerf
  const notifyReady = options.notifyReady
  const requestServerRedraw = options.requestServerRedraw
  let layoutTimeout: ReturnType<typeof setTimeout> | null = null
  let fontLayoutTimer: ReturnType<typeof setTimeout> | null = null
  let resizeStabilityFrame: number | null = null
  let resizeStableFrames = 0
  let resizeObservedSize = { width: 0, height: 0 }
  let sharedLayoutFrame: number | null = null
  let layoutFrame: number | null = null
  let repaintFrame: number | null = null
  let repaintTimers: ReturnType<typeof setTimeout>[] = []
  let lastContainerSize = { width: 0, height: 0 }
  let lastFitSize = { width: 0, height: 0 }
  let pendingLayoutForce = false
  let pendingLayoutResetFont = false
  let layoutRetryCount = 0
  let initialFitPending = false
  let lastRefreshAt = 0
  let lastDevicePixelRatio = window.devicePixelRatio || 1
  let mobileKeyboardTransition = false
  let observedResizeBurst = 0
  let observedResizeAt = 0
  let resizeThrottleAt = 0
  const revealMask = (generation?: number) => (options.revealMask ?? mask.reveal)(generation)
  const isTerminalScrolledBack = () => {
    const terminal = getTerminal()
    const activeBuffer = terminal?.buffer?.active
    const baseY = Number(activeBuffer?.baseY)
    const viewportY = Number(activeBuffer?.viewportY)
    if (Number.isFinite(baseY) && Number.isFinite(viewportY)) return viewportY < baseY - 1
    const viewport = terminal?.element?.querySelector('.xterm-viewport') as HTMLElement | null
    if (!viewport) return false
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2
  }
  const scrollTerminalToBottom = () => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    try {
      terminal.scrollToBottom?.()
    } catch {}
    const viewport = terminal?.element?.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }
  const refreshTerminalRows = (force = false) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    try {
      const now = performance.now()
      if (!force && isMobileDevice && now - lastRefreshAt < 120) return
      lastRefreshAt = now
      recordMobileDebug('terminal-refresh', { rows: terminal.rows })
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
    } catch {}
  }
  const repaintTerminalRenderer = (forceRefresh = false, stickToBottom = false) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    try {
      if (attachExclusiveRef.current) syncExclusiveViewport()
      else syncSharedViewport()
      if (stickToBottom) scrollTerminalToBottom()
      refreshTerminalRows(forceRefresh)
    } catch {}
  }
  const clearTerminalRepaint = () => {
    if (repaintFrame) {
      cancelAnimationFrame(repaintFrame)
      repaintFrame = null
    }
    for (const timer of repaintTimers) clearTimeout(timer)
    repaintTimers = []
  }
  const scheduleTerminalRepaint = (
    delays = TERMINAL_REPAINT_DELAYS,
    serverRedraw = false,
    stickToBottom = false,
    forceRefresh = false,
  ) => {
    if (isDisposed()) return
    clearTerminalRepaint()
    let redrawRequested = false
    const requestRedrawOnce = () => {
      if (!serverRedraw || redrawRequested) return
      redrawRequested = true
      requestServerRedraw()
    }
    for (const delay of delays) {
      if (delay <= 0) {
        repaintFrame = requestAnimationFrame(() => {
          repaintFrame = null
          repaintTerminalRenderer(forceRefresh, stickToBottom)
          requestRedrawOnce()
        })
        continue
      }
      const timer = setTimeout(() => {
        repaintTimers = repaintTimers.filter((item) => item !== timer)
        repaintTerminalRenderer(forceRefresh, stickToBottom)
        requestRedrawOnce()
      }, delay)
      repaintTimers.push(timer)
    }
  }
  const getCanvasSize = () => {
    const terminal = getTerminal()
    const canvas = terminal?._core?._renderService?.dimensions?.css?.canvas
    if (!canvas?.width || !canvas?.height) return null
    return { width: canvas.width, height: canvas.height }
  }
  const getTerminalPadding = () => {
    if (!container) {
      const padding = preferencesRef.current.terminalPadding
      return { left: padding, right: padding, top: padding, bottom: isMobileDevice ? 0 : padding }
    }
    const style = window.getComputedStyle(container)
    return {
      left: parseInt(style.getPropertyValue('padding-left')) || 0,
      right: parseInt(style.getPropertyValue('padding-right')) || 0,
      top: parseInt(style.getPropertyValue('padding-top')) || 0,
      bottom: parseInt(style.getPropertyValue('padding-bottom')) || 0,
    }
  }
  const getFitDimensions = () => {
    const terminal = getTerminal()
    if (!terminal?.element?.parentElement) return null
    const dims = terminal?._core?._renderService?.dimensions?.css
    const cellWidth = dims?.cell?.width
    const cellHeight = dims?.cell?.height
    if (!cellWidth || !cellHeight) return null
    const fontSize = Number(terminal.options.fontSize) || preferencesRef.current.fontSize
    if (cellWidth < Math.max(4, fontSize * 0.45) || cellHeight < Math.max(8, fontSize * 0.75)) return null
    const parentElement = terminal.element.parentElement
    const padding = getTerminalPadding()
    const parentHeight = Math.max(0, parentElement.clientHeight)
    const parentWidth = Math.max(0, parentElement.clientWidth)
    const paddingY = padding.top + padding.bottom
    const paddingX = padding.left + padding.right
    const availableHeight = Math.max(0, parentHeight - paddingY)
    const availableWidth = Math.max(0, parentWidth - paddingX)
    if (availableWidth < 8 || availableHeight < 8) return null
    const cols = Math.max(2, Math.floor(availableWidth / cellWidth))
    const rows = Math.max(1, Math.floor(availableHeight / cellHeight))
    return { cols, rows }
  }
  const getAvailableSize = () => {
    const padding = getTerminalPadding()
    return {
      width: Math.max(1, container.clientWidth - padding.left - padding.right),
      height: Math.max(1, container.clientHeight - padding.top - padding.bottom),
    }
  }
  const applyTerminalOptions = (fontSize?: number) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    terminal.options.fontFamily = preferencesRef.current.fontFamily
    terminal.options.fontWeight = '400'
    terminal.options.fontWeightBold = '700'
    terminal.options.cursorBlink = preferencesRef.current.cursorBlink
    const nextFontSize = (fontSize ?? Number(terminal.options.fontSize)) || preferencesRef.current.fontSize
    terminal.options.fontSize = nextFontSize
    terminal.options.letterSpacing = 0
    terminal.options.lineHeight = 1
    terminal.options.minimumContrastRatio = 4.5
    terminal.options.customGlyphs = true
  }
  const getRendererElements = () => {
    const terminal = getTerminal()
    const element = terminal?.element as HTMLElement | null
    if (!element) return null
    const screen = element.querySelector('.xterm-screen') as HTMLElement | null
    const rows = element.querySelector('.xterm-rows') as HTMLElement | null
    const viewport = element.querySelector('.xterm-viewport') as HTMLElement | null
    if (!screen || !rows || !viewport) return null
    return { element, screen, rows, viewport }
  }
  const applyRendererStyleCorrection = () => {
    if (isDisposed()) return
    const renderer = getRendererElements()
    if (!renderer) return
    const terminal = getTerminal()
    renderer.rows.style.setProperty('letter-spacing', '0px', 'important')
    renderer.rows.style.removeProperty('width')
    renderer.screen.style.removeProperty('width')
    renderer.screen.style.removeProperty('transform-origin')
    // transform 不能直接清：doFit 先排本修正到下一帧、再在当前帧 applyKeyboardClip，
    // 无脑 removeProperty 会把刚写的键盘底部锚定 translateY 擦掉（prompt 下跳/被裁）。
    // 统一交给 applyKeyboardClip 按当前键盘状态重算：非键盘场景它自己 removeProperty
    applyKeyboardClip()
    renderer.screen.style.removeProperty('will-change')
    if (attachExclusiveRef.current) {
      renderer.rows.style.setProperty('height', '100%', 'important')
      renderer.screen.style.setProperty('height', '100%', 'important')
      const cellHeight = Number(terminal?._core?._renderService?.dimensions?.css?.cell?.height)
      if (cellHeight)
        renderer.rows.style.setProperty(
          '--terminal-last-row-height',
          `${cellHeight + Math.max(0, getAvailableSize().height - cellHeight * terminal.rows)}px`,
        )
    } else {
      renderer.rows.style.removeProperty('height')
      renderer.screen.style.removeProperty('height')
      renderer.rows.style.removeProperty('--terminal-last-row-height')
    }
    renderer.viewport.style.setProperty('width', '100%', 'important')
  }
  const scheduleRendererStyleCorrection = () => {
    requestAnimationFrame(() => {
      applyRendererStyleCorrection()
    })
  }
  const clearTerminalRendererCache = () => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    try {
      terminal.clearTextureAtlas?.()
    } catch {}
    try {
      terminal._core?._renderService?.clear?.()
    } catch {}
  }
  const recoverTerminalScreen = (reason: string, serverRedraw = false) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    controlCarryRef.current = ''
    recordMobileDebug('terminal-recover', {
      reason,
      cols: terminal.cols,
      rows: terminal.rows,
      dpr: window.devicePixelRatio || 1,
    })
    clearTerminalRendererCache()
    try {
      terminal.clearSelection?.()
    } catch {}
    try {
      terminal.clear?.()
    } catch {}
    try {
      terminal.reset?.()
    } catch {}
    applyTerminalOptions()
    scheduleTerminalRepaint(
      isMobileDevice ? MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS : TERMINAL_RECOVERY_REPAINT_DELAYS,
      serverRedraw,
    )
  }
  const softRecoverTerminalScreen = (reason: string, serverRedraw = false) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return
    controlCarryRef.current = ''
    const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
    recordMobileDebug('terminal-soft-recover', {
      reason,
      cols: terminal.cols,
      rows: terminal.rows,
      dpr: window.devicePixelRatio || 1,
      stickToBottom,
    })
    clearTerminalRendererCache()
    try {
      terminal.clearSelection?.()
    } catch {}
    applyTerminalOptions()
    scheduleTerminalRepaint(
      isMobileDevice ? MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS : TERMINAL_RECOVERY_REPAINT_DELAYS,
      serverRedraw,
      stickToBottom,
      isMobileDevice,
    )
  }
  const syncRenderEnvironment = (reason: string) => {
    const dpr = window.devicePixelRatio || 1
    if (Math.abs(dpr - lastDevicePixelRatio) <= DEVICE_PIXEL_RATIO_TOLERANCE) return false
    lastDevicePixelRatio = dpr
    if (isMobileDevice) softRecoverTerminalScreen(reason, true)
    else recoverTerminalScreen(reason, true)
    return true
  }
  const clearViewportStyles = () => {
    const terminal = getTerminal()
    const element = terminal?.element as HTMLElement | null
    if (!element) return
    if (element.style.width !== '100%') element.style.width = '100%'
    if (element.style.height !== '100%') element.style.height = '100%'
    const screen = element.querySelector('.xterm-screen') as HTMLElement | null
    const canvases = screen
      ? (Array.from(screen.querySelectorAll('canvas:not(.xterm-link-layer)')) as HTMLCanvasElement[])
      : []
    if (screen?.style.transform) screen.style.removeProperty('transform')
    if (screen?.style.transformOrigin) screen.style.removeProperty('transform-origin')
    if (screen?.style.willChange) screen.style.removeProperty('will-change')
    for (const canvas of canvases) {
      canvas.style.removeProperty('transform')
      canvas.style.removeProperty('transform-origin')
    }
  }
  const applyKeyboardClip = () => {
    const terminal = getTerminal()
    const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    // 键盘开合只压缩可视高度、行列数不变：把 canvas 上移锚住底部，prompt 行保持可见
    const active = isMobileDevice && document.body.classList.contains('keyboard-open')
    const canvas = active ? getCanvasSize() : null
    const clip = canvas ? Math.max(0, canvas.height - getAvailableSize().height) : 0
    if (clip > 0) screen.style.transform = `translateY(${-clip}px)`
    else if (screen.style.transform) screen.style.removeProperty('transform')
  }
  const syncTerminalViewport = () => {
    const terminal = getTerminal()
    const element = terminal?.element as HTMLElement | null
    if (!element) return
    clearViewportStyles()
    applyKeyboardClip()
  }
  const syncExclusiveViewport = syncTerminalViewport
  const syncSharedViewport = syncTerminalViewport
  const doFit = (force = false) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed()) return false
    if (!attachExclusiveRef.current) return false
    try {
      const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
      const currentWidth = container.clientWidth
      const currentHeight = container.clientHeight
      recordMobileDebug('terminal-fit', { force, width: currentWidth, height: currentHeight })
      if (currentWidth < 8 || currentHeight < 8) return false
      if (
        !force &&
        Math.abs(currentWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE &&
        Math.abs(currentHeight - lastFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE &&
        lastSizeRef.current
      ) {
        recordMobileDebug('terminal-fit-noop', { width: currentWidth, height: currentHeight })
        // 本次 fit 没发 resize：拖动中本地反馈不等远端收敛（允许短暂错位后收敛），
        // 直接揭开；非拖动仍只有在途 resize 全清（resized/localOnly 已回）才本地揭开
        if (mask.isVisible() && (!pendingRemoteResizeRef.current || observedResizeBurst > 2)) revealMask()
        return true
      }
      applyTerminalOptions()
      const size = getFitDimensions()
      if (!size) return false
      const { cols, rows } = size
      if (cols && rows && cols > 0 && rows > 0) {
        lastFitSize = { width: currentWidth, height: currentHeight }
        if (terminal.cols !== cols || terminal.rows !== rows) {
          terminal.resize(cols, rows)
        }
        const prev = lastSizeRef.current
        const sizeChanged = !prev || prev.cols !== cols || prev.rows !== rows
        if (sizeChanged) {
          lastSizeRef.current = { cols, rows }
          const perf = options.getTerminalPerf()
          updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
          // 先于 onResize 置位：onResize 里去重/断线会同步发 localOnly resized 清掉它；
          // 无回调则永远等不到确认，不置位
          if (onResizeRef.current) pendingRemoteResizeRef.current = { cols, rows }
          onResizeRef.current?.(cols, rows)
        }
        requestAnimationFrame(() => {
          if (isDisposed() || !terminal) return
          scheduleRendererStyleCorrection()
          syncExclusiveViewport()
          if (force) {
            clearTerminalRendererCache()
            repaintTerminalRenderer(true, stickToBottom)
          } else if (isMobileDevice) {
            repaintTerminalRenderer(false, stickToBottom)
          }
          // 拖动（burst>2）期间本地视觉反馈不等远端收敛：本地 reflow 落地即揭，
          // 允许短暂错位由后续远端重绘自动收敛；非拖动的离散 resize 仍等
          // resized/localOnly 确认后才揭，避免旧列宽帧闪进新网格
          if (mask.isVisible() && (!pendingRemoteResizeRef.current || observedResizeBurst > 2)) revealMask()
        })
        notifyReady()
        return true
      }
    } catch (e) {}
    return false
  }
  const runLayoutSync = () => {
    const force = pendingLayoutForce
    const resetFont = pendingLayoutResetFont
    pendingLayoutForce = false
    pendingLayoutResetFont = false
    if (!attachExclusiveRef.current) {
      layoutRetryCount = 0
      initialFitPending = false
      mobileKeyboardTransition = false
      syncSharedLayout(resetFont)
      return
    }
    // 键盘开着时纯高度变化的非强制 sync 只做底部锚定：行数没变，refit 只会带来重排闪烁；
    // 宽度变化（如旋转）不属此类，继续走正常 fit
    const keyboardHeightOnly =
      isMobileDevice &&
      !force &&
      lastSizeRef.current &&
      Math.abs(container.clientWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE &&
      document.body.classList.contains('keyboard-open')
    if (keyboardHeightOnly) {
      layoutRetryCount = 0
      mobileKeyboardTransition = false
      applyKeyboardClip()
      return
    }
    if (doFit(force)) {
      layoutRetryCount = 0
      initialFitPending = false
      mobileKeyboardTransition = false
      return
    }
    if (!force || layoutRetryCount >= 12) {
      layoutRetryCount = 0
      initialFitPending = false
      mobileKeyboardTransition = false
      return
    }
    layoutRetryCount += 1
    scheduleLayoutSync(isMobileDevice ? 32 : 16, true, resetFont)
  }
  const scheduleLayoutSync = (delay = 0, force = false, resetFont = false) => {
    if (isDisposed()) return
    pendingLayoutForce = pendingLayoutForce || force
    pendingLayoutResetFont = pendingLayoutResetFont || resetFont
    if (layoutFrame) {
      if (initialFitPending && !force) return
      cancelAnimationFrame(layoutFrame)
      layoutFrame = null
    }
    if (layoutTimeout) {
      if (initialFitPending && !force) return
      clearTimeout(layoutTimeout)
      layoutTimeout = null
    }
    if (delay > 0) {
      layoutTimeout = setTimeout(() => {
        layoutTimeout = null
        runLayoutSync()
      }, delay)
      return
    }
    let synchronous = true
    const frame = requestAnimationFrame(() => {
      layoutFrame = null
      runLayoutSync()
      synchronous = false
    })
    if (synchronous) layoutFrame = frame
  }
  const scheduleInitialFit = () => {
    if (isDisposed()) return
    initialFitPending = true
    scheduleLayoutSync(isMobileDevice ? 80 : 0, true)
  }
  const scheduleStableLayout = () => {
    if (resizeStabilityFrame) return
    let synchronous = true
    const frame = requestAnimationFrame(() => {
      resizeStabilityFrame = null
      const width = container.clientWidth
      const height = container.clientHeight
      if (width !== resizeObservedSize.width || height !== resizeObservedSize.height) {
        resizeObservedSize = { width, height }
        resizeStableFrames = 0
      } else {
        resizeStableFrames += 1
      }
      if (resizeStableFrames < 2) {
        synchronous = false
        scheduleStableLayout()
        return
      }
      resizeStableFrames = 0
      scheduleLayoutSync(0, mobileKeyboardTransition, mobileKeyboardTransition)
      synchronous = false
    })
    if (synchronous) resizeStabilityFrame = frame
  }
  const syncSharedLayout = (resetFont: boolean, attempt = 0) => {
    const terminal = getTerminal()
    if (!terminal || isDisposed() || attachExclusiveRef.current) return
    const size = sharedSessionSizeRef.current
    if (!size || size.cols <= 0 || size.rows <= 0) return
    const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
    if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
    if (resetFont) {
      applyTerminalOptions()
    } else {
      terminal.options.fontFamily = preferencesRef.current.fontFamily
      terminal.options.fontWeight = '400'
      terminal.options.fontWeightBold = '700'
      terminal.options.cursorBlink = preferencesRef.current.cursorBlink
    }
    if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
      terminal.resize(size.cols, size.rows)
    }
    let synchronous = true
    const frame = requestAnimationFrame(() => {
      // 入口即释放句柄：下面任一分支 early return 之后都不得留下假 pending，
      // 否则 isSyncPending 永久为真，finishSessionSwitch 会空等到 SWITCH_HOLD_TIMEOUT_MS
      sharedLayoutFrame = null
      synchronous = false
      if (isDisposed()) return
      const canvas = getCanvasSize()
      if (!canvas) return
      const available = getAvailableSize()
      const widthScale = available.width / canvas.width
      const heightScale = available.height / canvas.height
      const scale = isMobileDevice ? Math.min(widthScale, Math.max(heightScale, 1)) : Math.min(widthScale, heightScale)
      if (!Number.isFinite(scale) || scale <= 0) return
      const currentFontSize = Number(terminal.options.fontSize) || preferencesRef.current.fontSize
      const nextFontSize = Math.max(6, Math.min(72, Math.round(currentFontSize * scale * 10) / 10))
      if (attempt < 2 && Math.abs(scale - 1) > 0.03 && Math.abs(nextFontSize - currentFontSize) > 0.2) {
        terminal.options.fontSize = nextFontSize
        syncSharedLayout(false, attempt + 1)
        return
      }
      if (isMobileDevice) syncSharedViewport()
      repaintTerminalRenderer(isMobileDevice, stickToBottom)
      const prev = lastSizeRef.current
      lastSizeRef.current = { cols: size.cols, rows: size.rows }
      const sizeChanged = !prev || prev.cols !== size.cols || prev.rows !== size.rows
      if (sizeChanged) {
        const perf = options.getTerminalPerf()
        updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
        if (onResizeRef.current) pendingRemoteResizeRef.current = { cols: size.cols, rows: size.rows }
        onResizeRef.current?.(size.cols, size.rows)
      }
      // 与 doFit 同一规则：拖动中不等 ACK 直接揭，非拖动有在途 resize 等 ACK，无则立即揭
      if (mask.isVisible() && (!pendingRemoteResizeRef.current || observedResizeBurst > 2)) revealMask()
    })
    if (synchronous) sharedLayoutFrame = frame
  }
  const primeContainerSize = () => {
    lastContainerSize = { width: container.clientWidth, height: container.clientHeight }
    resizeObservedSize = lastContainerSize
  }
  const notifyObservedResize = () => {
    const width = container.clientWidth
    const height = container.clientHeight
    recordMobileDebug('terminal-resize-observer', { width, height })
    if (
      Math.abs(width - lastContainerSize.width) <= MOBILE_FIT_SIZE_TOLERANCE &&
      Math.abs(height - lastContainerSize.height) <= MOBILE_FIT_SIZE_TOLERANCE
    )
      return
    const hadContainerSize = lastContainerSize.width > 0 && lastContainerSize.height > 0
    const widthChanged = Math.abs(width - lastContainerSize.width) > MOBILE_FIT_SIZE_TOLERANCE
    lastContainerSize = { width, height }
    resizeObservedSize = { width, height }
    resizeStableFrames = 0
    // 真实容器变化即算拖动活动（哪怕最终换算成相同行列）：远端静止窗以此为准，
    // 不能用节流后 ~140ms 一发的 onResize 反推停止——慢拖/同格像素变也会命中
    options.onResizeActivityRef?.current?.()
    // 键盘开着时纯高度变化不 refit（宽度变仍走正常流程，如旋转）
    if (
      isMobileDevice &&
      attachExclusiveRef.current &&
      hadContainerSize &&
      !widthChanged &&
      document.body.classList.contains('keyboard-open')
    ) {
      applyKeyboardClip()
      return
    }
    const now = Date.now()
    observedResizeBurst = now - observedResizeAt < 250 ? observedResizeBurst + 1 : 1
    observedResizeAt = now
    // 拖动（burst>2）不盖整屏克隆遮罩：跟手优先，活画面渐进显示 + 节流 fit；
    // 离散跳变仍盖遮罩避免露出旧列宽的中间帧
    if (hadContainerSize && !isMobileDevice && observedResizeBurst <= 2) mask.show()
    // 拖动中每次观察都重置静止计数，等 2 个稳定帧的收敛永远到不了：
    // burst>2（250ms 窗口内第 3 次起）视为拖动，按 DRAG_FIT_INTERVAL_MS 节流
    // 做中间 fit 推进；单次/双次跳变仍走纯稳定检测，不多发 resize
    if (observedResizeBurst > 2 && now - resizeThrottleAt >= DRAG_FIT_INTERVAL_MS) {
      resizeThrottleAt = now
      scheduleLayoutSync(0, false)
    }
    scheduleStableLayout()
  }
  const notifyWindowResize = () => {
    syncRenderEnvironment('window-resize')
    // window resize 与 RO 是同一次实际尺寸变化的两个信号：委托共享观察路径——
    // 同尺寸早退不重复计数，burst/拖动免遮罩判定对两者一致生效；
    // 无条件 mask.show 会让持续 window 事件一直重置 generation 使遮罩不撤
    notifyObservedResize()
  }
  const scheduleFontLayout = () => {
    if (isMobileDevice) return
    if (fontLayoutTimer) clearTimeout(fontLayoutTimer)
    fontLayoutTimer = setTimeout(() => {
      fontLayoutTimer = null
      scheduleLayoutSync(0, true, true)
    }, 48)
  }
  const dispose = () => {
    if (layoutTimeout) clearTimeout(layoutTimeout)
    if (fontLayoutTimer) clearTimeout(fontLayoutTimer)
    if (resizeStabilityFrame) cancelAnimationFrame(resizeStabilityFrame)
    if (layoutFrame) cancelAnimationFrame(layoutFrame)
    clearTerminalRepaint()
    if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
  }
  return {
    isTerminalScrolledBack,
    scrollTerminalToBottom,
    refreshTerminalRows,
    repaintTerminalRenderer,
    clearTerminalRepaint,
    scheduleTerminalRepaint,
    applyTerminalOptions,
    scheduleRendererStyleCorrection,
    clearTerminalRendererCache,
    recoverTerminalScreen,
    softRecoverTerminalScreen,
    syncRenderEnvironment,
    syncExclusiveViewport,
    syncSharedViewport,
    scheduleLayoutSync,
    // 切换攒流用：resize/fontScale 的 rAF 链是否仍在途，flush 须等它落地
    // resizeStabilityFrame 也算在途：稳定检测两帧窗口内 fit 尚未跑完，调用方
    // （如远端 resize 静止窗）需要"最终 fit 已落地"判据，不能只看调度句柄
    isSyncPending: () => Boolean(layoutFrame || layoutTimeout || sharedLayoutFrame || resizeStabilityFrame),
    // 同步读当前容器几何对应的目标行列：pointer settle 提交时用它替代"等 fit
    // 管线收尾"（稳定帧链 ~50ms），随后 fit 产出同尺寸走 dedup 不会二次发送
    peekFitSize: () => getFitDimensions(),
    scheduleInitialFit,
    scheduleStableLayout,
    primeContainerSize,
    notifyObservedResize,
    notifyWindowResize,
    scheduleFontLayout,
    setMobileKeyboardTransition: (value: boolean) => {
      mobileKeyboardTransition = value
    },
    dispose,
    delays: {
      TERMINAL_REPAINT_DELAYS,
      MOBILE_TERMINAL_REPAINT_DELAYS,
      LAYOUT_REPAINT_DELAYS: [0, 32],
      MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS: [0, 48, 160],
    },
  }
}
