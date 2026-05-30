'use client'

import { useEffect, useRef, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'
import { usePreferences } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { DELETE_NEXT_WORD_SEQUENCE, DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useTerminalOutput } from '@/hooks/useTerminalOutput'
import { useTerminalDrop } from '@/hooks/useTerminalDrop'
import { useTerminalPasteBridge } from '@/hooks/useTerminalPasteBridge'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useTerminalSelectionSync } from '@/hooks/useTerminalSelectionSync'
import { useTranslation } from '@/i18n'
import { useTerminalTouchScroll } from '@/hooks/useTerminalTouchScroll'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'

const SCROLLBACK_LIMIT = 600
const DELETE_WORD_REPEAT_DELAY = 140
const DELETE_WORD_REPEAT_SECOND_DELAY = 109
const DELETE_WORD_REPEAT_THIRD_DELAY = 78
const DELETE_WORD_REPEAT_FOURTH_DELAY = 56
const DELETE_WORD_REPEAT_MIN_DELAY = 30
const DEFAULT_TERMINAL_PERF = { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' }
const TERMINAL_REPAINT_DELAYS = [0, 16, 48, 120, 260]
const MOBILE_TERMINAL_REPAINT_DELAYS = [96]
const TERMINAL_RECOVERY_REPAINT_DELAYS = [0, 16, 64, 180]
const MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS = [48, 160]
const MOBILE_FIT_DEBOUNCE_MS = 96
const MOBILE_FIT_SIZE_TOLERANCE = 2
const DEVICE_PIXEL_RATIO_TOLERANCE = 0.01
const MOBILE_PINCH_MIN_FONT_SIZE = 12
const MOBILE_PINCH_MAX_FONT_SIZE = 20
const MOBILE_PINCH_FONT_SIZE_EPSILON = 0.04
const MOBILE_PINCH_DISTANCE_EPSILON = 2
function recordMobileDebug(event: string, data?: Record<string, unknown>) {
  recordMobileDiagnostic(event, data)
  if (typeof window === 'undefined' || !window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target = window as typeof window & { __tmuxgoMobileDebug?: { events: Array<Record<string, unknown>> } }
  const state = target.__tmuxgoMobileDebug || { events: [] }
  state.events.push({ event, at: Math.round(performance.now()), ...data })
  state.events = state.events.slice(-240)
  target.__tmuxgoMobileDebug = state
}

interface TerminalPaneProps {
  sessionName?: string
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
  subscribeOutput?: (listener: (message: { data: string; sessionName?: string | null }) => void) => () => void
}

function isApplePlatform() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

function isPasteShortcut(e: KeyboardEvent) {
  if (e.altKey || e.key.toLowerCase() !== 'v') return false
  if (e.ctrlKey && !e.metaKey) return true
  if (e.metaKey && !e.ctrlKey && isApplePlatform()) return true
  return false
}

export function TerminalPane({ sessionName, onInput, onResize, attachExclusive = false, onReady, subscribeOutput }: TerminalPaneProps) {
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const setActivePane = useConsoleStore((s) => s.setActivePane)
  const updateTerminalPerf = useConsoleStore((s) => s.updateTerminalPerf)
  const recordTerminalOutput = useTerminalOutput()
  const queryClient = useOptionalQueryClient()
  const terminalRef = useRef<HTMLDivElement>(null)
  const touchMovedRef = useRef(false)
  const terminalInstance = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)
  const attachExclusiveRef = useRef(attachExclusive)
  const onReadyRef = useRef(onReady)
  const sessionNameRef = useRef(sessionName)
  const preferencesRef = useRef(preferences)
  const subscribeOutputRef = useRef(subscribeOutput)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const scheduleFitRef = useRef<(delay?: number, force?: boolean) => void>(() => {})
  const forceStableFitRef = useRef<() => void>(() => {})
  const syncSharedLayoutRef = useRef<(resetFont: boolean) => void>(() => {})
  const activeHostIdRef = useRef(activeHostId)
  const sessionSnapshotRef = useRef<any | null>(null)
  const updatePreferencesRef = useRef(updatePreferences)
  const pinchStateRef = useRef({ active: false, startDistance: 0, startFontSize: preferences.fontSize, lastFontSize: preferences.fontSize })
  const dispatchTerminalTap = useCallback((x: number, y: number) => {
    const container = terminalRef.current
    if (!container) return
    const target = document.elementFromPoint(x, y) as HTMLElement | null
    const terminalTarget = target?.closest('.xterm-screen') || target?.closest('.xterm') || container.querySelector('.xterm-screen') || container.querySelector('.xterm')
    if (!(terminalTarget instanceof HTMLElement)) return
    const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, composed: true }
    terminalTarget.dispatchEvent(new MouseEvent('mousemove', options))
    terminalTarget.dispatchEvent(new MouseEvent('mousedown', options))
    terminalTarget.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
    terminalTarget.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0, detail: 1 }))
  }, [])

  const { send } = useWebSocket()
  const sendRef = useRef(send)
  const sendInput = useCallback((data: string) => onInputRef.current?.(data), [])
  const { textareaRef, focusKeyboard, isMobile: isMobileDevice } = useMobileKeyboard(sendInput, terminalRef)
  const dropState = useTerminalDrop(sendInput, openUploadDialog)
  const pasteBridge = useTerminalPasteBridge()
  const selectionSync = useTerminalSelectionSync(pushToast)
  const handleTouchScroll = useCallback((lines: number) => send({ type: 'pane_scroll', sessionName: sessionNameRef.current, lines }), [send])
  const handleTouchTap = useCallback((x: number, y: number) => {
    lastTapRef.current = { x, y }
  }, [])
  const handleTouchMovedChange = useCallback((moved: boolean) => {
    touchMovedRef.current = moved
  }, [])
  const clampMobileFontSize = useCallback((value: number) => {
    const rounded = Math.round(value * 10) / 10
    return Math.max(MOBILE_PINCH_MIN_FONT_SIZE, Math.min(MOBILE_PINCH_MAX_FONT_SIZE, rounded))
  }, [])
  const getPinchDistance = useCallback((touches: TouchList) => {
    if (touches.length < 2) return 0
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.hypot(dx, dy)
  }, [])
  const applyPinchFontSize = useCallback((fontSize: number) => {
    const terminal = terminalInstance.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    if (attachExclusiveRef.current) scheduleFitRef.current(0, true)
    else syncSharedLayoutRef.current(true)
  }, [])
  const beginPinch = useCallback((touches: TouchList) => {
    if (!isMobileDevice || touches.length < 2) return
    const distance = getPinchDistance(touches)
    if (!Number.isFinite(distance) || distance < MOBILE_PINCH_DISTANCE_EPSILON) return
    const currentFontSize = Number(terminalInstance.current?.options?.fontSize) || preferencesRef.current.fontSize
    const startFontSize = clampMobileFontSize(currentFontSize)
    pinchStateRef.current.active = true
    pinchStateRef.current.startDistance = distance
    pinchStateRef.current.startFontSize = startFontSize
    pinchStateRef.current.lastFontSize = startFontSize
    touchMovedRef.current = true
  }, [clampMobileFontSize, getPinchDistance, isMobileDevice])
  const commitPinch = useCallback(() => {
    const state = pinchStateRef.current
    if (!state.active) return
    state.active = false
    const nextFontSize = clampMobileFontSize(state.lastFontSize || state.startFontSize || preferencesRef.current.fontSize)
    state.startDistance = 0
    state.startFontSize = nextFontSize
    state.lastFontSize = nextFontSize
    if (Math.abs(nextFontSize - preferencesRef.current.fontSize) < MOBILE_PINCH_FONT_SIZE_EPSILON) return
    updatePreferencesRef.current({ fontSize: nextFontSize })
  }, [clampMobileFontSize])
  const handlePinchTouchStart = useCallback((e: TouchEvent) => {
    if (!isMobileDevice) return
    if (e.touches.length < 2) return
    beginPinch(e.touches)
  }, [beginPinch, isMobileDevice])
  const handlePinchTouchMove = useCallback((e: TouchEvent) => {
    if (!isMobileDevice || e.touches.length < 2) return
    if (!pinchStateRef.current.active) beginPinch(e.touches)
    if (!pinchStateRef.current.active) return
    e.preventDefault()
    touchMovedRef.current = true
    const state = pinchStateRef.current
    const distance = getPinchDistance(e.touches)
    if (!Number.isFinite(distance) || distance < MOBILE_PINCH_DISTANCE_EPSILON || state.startDistance < MOBILE_PINCH_DISTANCE_EPSILON) return
    const nextFontSize = clampMobileFontSize(state.startFontSize * (distance / state.startDistance))
    if (Math.abs(nextFontSize - state.lastFontSize) < MOBILE_PINCH_FONT_SIZE_EPSILON) return
    state.lastFontSize = nextFontSize
    applyPinchFontSize(nextFontSize)
  }, [applyPinchFontSize, beginPinch, clampMobileFontSize, getPinchDistance, isMobileDevice])
  const handlePinchTouchEnd = useCallback((e: TouchEvent) => {
    if (!pinchStateRef.current.active) return
    touchMovedRef.current = true
    if (e.touches.length >= 2) {
      const distance = getPinchDistance(e.touches)
      if (Number.isFinite(distance) && distance >= MOBILE_PINCH_DISTANCE_EPSILON) {
        pinchStateRef.current.startDistance = distance
        pinchStateRef.current.startFontSize = pinchStateRef.current.lastFontSize
      }
      return
    }
    commitPinch()
  }, [commitPinch, getPinchDistance])
  const handlePinchTouchCancel = useCallback(() => {
    if (!pinchStateRef.current.active) return
    touchMovedRef.current = true
    commitPinch()
  }, [commitPinch])
  const touchScroll = useTerminalTouchScroll({
    isMobile: isMobileDevice,
    onScroll: handleTouchScroll,
    onTap: handleTouchTap,
    onTouchMovedChange: handleTouchMovedChange,
  })
  useEffect(() => {
    onInputRef.current = onInput
  }, [onInput])
  useEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])
  useEffect(() => {
    attachExclusiveRef.current = attachExclusive
  }, [attachExclusive])
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  useEffect(() => {
    sessionNameRef.current = sessionName
  }, [sessionName])
  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])
  useEffect(() => {
    subscribeOutputRef.current = subscribeOutput
  }, [subscribeOutput])
  useEffect(() => {
    activeHostIdRef.current = activeHostId
  }, [activeHostId])
  useEffect(() => {
    sendRef.current = send
  }, [send])
  useEffect(() => {
    updatePreferencesRef.current = updatePreferences
  }, [updatePreferences])

  useEffect(() => {
    const terminal = terminalInstance.current
    if (!terminal) return
    const style = getComputedStyle(document.documentElement)
    const getVar = (name: string) => style.getPropertyValue(name).trim()
    terminal.options.theme = {
      background: `rgb(${getVar('--bg-1')})`,
      foreground: `rgb(${getVar('--text-1')})`,
      cursor: `rgb(${getVar('--accent')})`,
      selectionBackground: `rgb(${getVar('--accent')} / 0.2)`,
    }
  }, [preferences.theme])

  useEffect(() => {
    const terminal = terminalInstance.current
    if (!terminal) return
    terminal.options.fontSize = preferences.fontSize
    terminal.options.fontFamily = preferences.fontFamily
    if (attachExclusiveRef.current) {
      scheduleFitRef.current(0, true)
    } else {
      syncSharedLayoutRef.current(true)
    }
  }, [preferences.fontSize, preferences.fontFamily])

  useEffect(() => {
    if (!terminalRef.current) return
    const container = terminalRef.current
    let terminal: any = null
    let fitAddon: any = null
    let resizeObserver: ResizeObserver | null = null
    let disposables: any[] = []
    let fitTimeout: NodeJS.Timeout | null = null
    let stableFitTimer: ReturnType<typeof setTimeout> | null = null
    let sharedLayoutFrame: number | null = null
    let fitFrame: number | null = null
    let repaintFrame: number | null = null
    let repaintTimers: ReturnType<typeof setTimeout>[] = []
    let disposed = false
    let readyNotified = false
    let sharedPanX = 0
    let sharedMaxPanX = 0
    let lastContainerSize = { width: 0, height: 0 }
    let lastFitSize = { width: 0, height: 0 }
    let pendingFitSize = { width: 0, height: 0 }
    let stableFitToken = 0
    let lastRefreshAt = 0
    let lastDevicePixelRatio = window.devicePixelRatio || 1
    let deleteWordRepeatTimer: ReturnType<typeof setTimeout> | null = null
    let deleteWordRepeatActive = false
    let pointerSyncActive = false
    let lastKeyboardOpen = document.body.classList.contains('keyboard-open')
    let paneResizeDrag: any = null
    let paneBoundsCache: { snapshot: any; windowId: string; bounds: any[] } | null = null
    let paneResizeHoverThrottle = 0
    let attachEventCount = 0
    let outputSinceLastAttach = false

    const notifyReady = () => {
      if (disposed || readyNotified) return
      readyNotified = true
      onReadyRef.current?.()
    }
    const focusTerminalInput = () => {
      if (isMobileDevice) {
        focusKeyboard()
        return
      }
      terminal?.focus?.()
      container.focus()
      const input = container.querySelector('.xterm-helper-textarea, textarea')
      if (input instanceof HTMLTextAreaElement) input.focus({ preventScroll: true })
    }
    const getSessionSnapshotKey = () => {
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!hostId || !currentSessionName) return null
      return ['session-snapshot', hostId, `session-${currentSessionName}`]
    }
    const readSessionSnapshot = () => {
      const key = getSessionSnapshotKey()
      const cached = key ? queryClient?.getQueryData?.(key) : null
      if (cached) sessionSnapshotRef.current = cached
      return sessionSnapshotRef.current
    }
    const loadSessionSnapshot = async () => {
      const key = getSessionSnapshotKey()
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!key || !hostId || !currentSessionName) return null
      const snapshot = await api.snapshot.get(hostId, `session-${currentSessionName}`)
      sessionSnapshotRef.current = snapshot
      queryClient?.setQueryData(key, snapshot)
      return snapshot
    }
    const getPaneBounds = (pane: any) => {
      const id = String(pane?.id ?? pane?.tmuxPaneId ?? '')
      const left = Number(pane?.left ?? pane?.position?.left)
      const top = Number(pane?.top ?? pane?.position?.top)
      const cols = Number(pane?.size?.cols ?? pane?.cols)
      const rows = Number(pane?.size?.rows ?? pane?.rows)
      if (![left, top, cols, rows].every(Number.isFinite) || cols <= 0 || rows <= 0) return null
      return { id, left, top, cols, rows }
    }
    const getCachedPaneBounds = () => {
      const snapshot = readSessionSnapshot()
      if (!snapshot) return [] as any[]
      const session = snapshot?.sessionName || sessionNameRef.current || ''
      const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : []
      const activeWindow = windows.find((item: any) => item.id === snapshot?.activeWindowId) || windows.find((item: any) => item.active)
      const index = Number(activeWindow?.index)
      const windowId = Number.isFinite(index) ? `${session}:${index}` : ''
      if (paneBoundsCache && paneBoundsCache.snapshot === snapshot && paneBoundsCache.windowId === windowId) {
        return paneBoundsCache.bounds
      }
      const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : []
      const filtered = windowId ? panes.filter((pane: any) => {
        const id = String(pane.windowId || '')
        return id === windowId || id.endsWith(`:${index}`)
      }) : panes
      const bounds = filtered.map(getPaneBounds).filter(Boolean) as any[]
      paneBoundsCache = { snapshot, windowId, bounds }
      return bounds
    }
    const getSelectionText = () => terminal?.getSelection?.() || window.getSelection?.()?.toString() || ''
    const getMouseCell = (event: MouseEvent) => {
      const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen || !terminal?.cols || !terminal?.rows) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      const dims = terminal?._core?._renderService?.dimensions?.css
      const cellWidth = Number(dims?.cell?.width) || rect.width / terminal.cols
      const cellHeight = Number(dims?.cell?.height) || rect.height / terminal.rows
      if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return null
      const x = Math.floor((event.clientX - rect.left) / cellWidth)
      const y = Math.floor((event.clientY - rect.top) / cellHeight)
      if (x < 0 || y < 0 || x >= terminal.cols || y >= terminal.rows) return null
      return { x, y }
    }
    const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(aStart, bStart) <= Math.min(aEnd, bEnd)
    const getPaneResizeTarget = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
      const cell = getMouseCell(event)
      if (!cell) return null
      const panes = getCachedPaneBounds()
      if (!panes.length) return null
      const vertical = panes.find((pane) => {
        if (!pane.id) return false
        const edge = pane.left + pane.cols
        if (Math.abs(cell.x - edge) > 1 || cell.y < pane.top || cell.y >= pane.top + pane.rows) return false
        return panes.some((other) => other.left === edge + 1 && rangesOverlap(pane.top, pane.top + pane.rows - 1, other.top, other.top + other.rows - 1))
      })
      if (vertical) return { axis: 'x', paneId: vertical.id, startCell: vertical.left + vertical.cols, startSize: vertical.cols }
      const horizontal = panes.find((pane) => {
        if (!pane.id) return false
        const edge = pane.top + pane.rows
        if (Math.abs(cell.y - edge) > 1 || cell.x < pane.left || cell.x >= pane.left + pane.cols) return false
        return panes.some((other) => other.top === edge + 1 && rangesOverlap(pane.left, pane.left + pane.cols - 1, other.left, other.left + other.cols - 1))
      })
      if (horizontal) return { axis: 'y', paneId: horizontal.id, startCell: horizontal.top + horizontal.rows, startSize: horizontal.rows }
      return null
    }
    const sendPaneResize = (drag: any) => {
      if (!drag || drag.inFlight || !drag.pendingSize || drag.pendingSize === drag.sentSize) return
      const size = drag.pendingSize
      drag.sentSize = size
      drag.inFlight = true
      void api.panes.resize(drag.paneId, drag.axis === 'x' ? { cols: size } : { rows: size }).catch(() => {}).finally(() => {
        drag.inFlight = false
        void loadSessionSnapshot()
        if (paneResizeDrag === drag && drag.pendingSize !== drag.sentSize) {
          sendPaneResize(drag)
          return
        }
        if (paneResizeDrag === drag && drag.released) paneResizeDrag = null
      })
    }
    const schedulePaneResize = (drag: any) => {
      if (drag.frame) return
      drag.frame = requestAnimationFrame(() => {
        drag.frame = null
        sendPaneResize(drag)
      })
    }
    const updatePaneResizeDrag = (event: MouseEvent) => {
      const drag = paneResizeDrag
      if (!drag) return
      const cell = getMouseCell(event)
      if (!cell) return
      const delta = (drag.axis === 'x' ? cell.x : cell.y) - drag.startCell
      const nextSize = Math.max(4, drag.startSize + delta)
      if (nextSize === drag.pendingSize) return
      drag.pendingSize = nextSize
      schedulePaneResize(drag)
    }
    const handlePaneResizeMove = (event: MouseEvent) => {
      if (!paneResizeDrag) return
      event.preventDefault()
      updatePaneResizeDrag(event)
    }
    const endPaneResizeDrag = () => {
      const drag = paneResizeDrag
      if (!drag) return
      if (drag.frame) cancelAnimationFrame(drag.frame)
      drag.released = true
      sendPaneResize(drag)
      if (!drag.inFlight && drag.pendingSize === drag.sentSize) paneResizeDrag = null
      container.style.cursor = ''
      window.removeEventListener('mousemove', handlePaneResizeMove)
      window.removeEventListener('mouseup', endPaneResizeDrag)
      window.removeEventListener('blur', endPaneResizeDrag)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'tmux-pane-resize' } }))
      setTimeout(() => void loadSessionSnapshot(), 80)
    }
    const handlePaneResizeStart = (event: MouseEvent) => {
      const target = getPaneResizeTarget(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      pointerSyncActive = false
      selectionSync.clearCopySelectionTimer()
      try {
        terminal?.clearSelection?.()
      } catch {}
      paneResizeDrag = { ...target, pendingSize: target.startSize, sentSize: target.startSize, inFlight: false, frame: null }
      container.style.cursor = target.axis === 'x' ? 'col-resize' : 'row-resize'
      window.addEventListener('mousemove', handlePaneResizeMove)
      window.addEventListener('mouseup', endPaneResizeDrag)
      window.addEventListener('blur', endPaneResizeDrag)
    }
    const handlePaneResizeHover = (event: MouseEvent) => {
      if (paneResizeDrag) return
      const now = performance.now()
      if (now - paneResizeHoverThrottle < 50) return
      paneResizeHoverThrottle = now
      const target = getPaneResizeTarget(event)
      container.style.cursor = target ? target.axis === 'x' ? 'col-resize' : 'row-resize' : ''
    }
    const clearPaneResizeHover = () => {
      if (!paneResizeDrag) container.style.cursor = ''
    }
    const stopDeleteWordRepeat = () => {
      deleteWordRepeatActive = false
      if (deleteWordRepeatTimer) {
        clearTimeout(deleteWordRepeatTimer)
        deleteWordRepeatTimer = null
      }
    }
    const startDeleteWordRepeat = () => {
      stopDeleteWordRepeat()
      deleteWordRepeatActive = true
      let delay = DELETE_WORD_REPEAT_DELAY
      let repeatCount = 0
      const tick = () => {
        if (disposed || !deleteWordRepeatActive) return
        onInputRef.current?.(DELETE_PREV_WORD_SEQUENCE)
        repeatCount += 1
        delay = repeatCount === 1 ? DELETE_WORD_REPEAT_SECOND_DELAY : repeatCount === 2 ? DELETE_WORD_REPEAT_THIRD_DELAY : repeatCount === 3 ? DELETE_WORD_REPEAT_FOURTH_DELAY : DELETE_WORD_REPEAT_MIN_DELAY
        deleteWordRepeatTimer = setTimeout(tick, delay)
      }
      deleteWordRepeatTimer = setTimeout(tick, delay)
    }
    const syncActivePane = async () => {
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!hostId || !currentSessionName) return
      try {
        const snapshot = await loadSessionSnapshot()
        if (snapshot?.activePaneId) setActivePane(snapshot.activePaneId)
      } catch {}
    }
    const requestServerRedraw = () => {
      const currentSessionName = sessionNameRef.current
      if (!currentSessionName) return
      sendRef.current({ type: 'redraw', sessionName: currentSessionName })
    }
    const refreshTerminalRows = () => {
      if (!terminal || disposed) return
      try {
        const now = performance.now()
        if (isMobileDevice && now - lastRefreshAt < 120) return
        lastRefreshAt = now
        recordMobileDebug('terminal-refresh', { rows: terminal.rows })
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {}
    }
    const repaintTerminalRenderer = () => {
      if (!terminal || disposed) return
      try {
        if (attachExclusiveRef.current) syncExclusiveViewport()
        else syncSharedViewport()
        refreshTerminalRows()
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
    const scheduleTerminalRepaint = (delays = TERMINAL_REPAINT_DELAYS, serverRedraw = false) => {
      if (disposed) return
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
            repaintTerminalRenderer()
            requestRedrawOnce()
          })
          continue
        }
        const timer = setTimeout(() => {
          repaintTimers = repaintTimers.filter((item) => item !== timer)
          repaintTerminalRenderer()
          requestRedrawOnce()
        }, delay)
        repaintTimers.push(timer)
      }
    }

    const getCanvasSize = () => {
      const canvas = terminal?._core?._renderService?.dimensions?.css?.canvas
      if (!canvas?.width || !canvas?.height) return null
      return { width: canvas.width, height: canvas.height }
    }
    const getScreenSize = () => {
      const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      return { width: rect.width, height: rect.height }
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
      if (!terminal || disposed) return
      terminal.options.fontFamily = preferencesRef.current.fontFamily
      terminal.options.cursorBlink = preferencesRef.current.cursorBlink
      const nextFontSize = (fontSize ?? Number(terminal.options.fontSize)) || preferencesRef.current.fontSize
      terminal.options.fontSize = nextFontSize
      terminal.options.lineHeight = 1
    }
    const clearTerminalRendererCache = () => {
      if (!terminal || disposed) return
      try {
        terminal.clearTextureAtlas?.()
      } catch {}
      try {
        terminal._core?._renderService?.clear?.()
      } catch {}
    }
    const recoverTerminalScreen = (reason: string, serverRedraw = true) => {
      if (!terminal || disposed) return
      controlCarryRef.current = ''
      recordMobileDebug('terminal-recover', { reason, cols: terminal.cols, rows: terminal.rows, dpr: window.devicePixelRatio || 1 })
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
      scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS : TERMINAL_RECOVERY_REPAINT_DELAYS, serverRedraw)
    }
    const syncRenderEnvironment = (reason: string) => {
      const dpr = window.devicePixelRatio || 1
      if (Math.abs(dpr - lastDevicePixelRatio) <= DEVICE_PIXEL_RATIO_TOLERANCE) return false
      lastDevicePixelRatio = dpr
      recoverTerminalScreen(reason, true)
      return true
    }
    const clearViewportStyles = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      sharedPanX = 0
      sharedMaxPanX = 0
      if (element.style.width !== '100%') element.style.width = '100%'
      if (element.style.height !== '100%') element.style.height = '100%'
      if (element.style.transform) element.style.removeProperty('transform')
      if (element.style.transformOrigin) element.style.removeProperty('transform-origin')
      if (element.style.willChange) element.style.removeProperty('will-change')
    }
    const syncExclusiveViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (!attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      clearViewportStyles()
    }
    const syncSharedViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      clearViewportStyles()
    }
    const doFit = (force = false) => {
      if (!fitAddon || !terminal || disposed) return false
      if (!attachExclusiveRef.current) return false
      try {
        const currentWidth = container.clientWidth
        const currentHeight = container.clientHeight
        recordMobileDebug('terminal-fit', { force, width: currentWidth, height: currentHeight })
        if (!force && Math.abs(currentWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(currentHeight - lastFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE && lastSizeRef.current) {
          recordMobileDebug('terminal-fit-noop', { width: currentWidth, height: currentHeight })
          return true
        }
        lastFitSize = { width: currentWidth, height: currentHeight }
        applyTerminalOptions()
        fitAddon.fit()
        let size = terminal.cols > 0 && terminal.rows > 0 ? { cols: terminal.cols, rows: terminal.rows } : null
        if (!size) size = getFitDimensions()
        if (!size) return false
        const { cols, rows } = size
        if (cols && rows && cols > 0 && rows > 0) {
          if (terminal.cols !== cols || terminal.rows !== rows) {
            terminal.resize(cols, rows)
          }
          const prev = lastSizeRef.current
          if (!prev || prev.cols !== cols || prev.rows !== rows) {
            lastSizeRef.current = { cols, rows }
            onResizeRef.current?.(cols, rows)
          }
          requestAnimationFrame(() => {
            if (disposed || !terminal) return
            syncExclusiveViewport()
            repaintTerminalRenderer()
          })
          notifyReady()
          return true
        }
      } catch (e) {
      }
      return false
    }
    const scheduleFit = (delay = 0, force = false) => {
      if (disposed) return
      if (isMobileDevice && !force) {
        const width = container.clientWidth
        const height = container.clientHeight
        if (Math.abs(width - pendingFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(height - pendingFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE && lastSizeRef.current) return
        pendingFitSize = { width, height }
        if (fitTimeout) clearTimeout(fitTimeout)
        if (fitFrame) cancelAnimationFrame(fitFrame)
        fitTimeout = setTimeout(() => {
          fitTimeout = null
          doFit(false)
        }, Math.max(delay, MOBILE_FIT_DEBOUNCE_MS))
        return
      }
      if (fitTimeout) {
        clearTimeout(fitTimeout)
        fitTimeout = null
      }
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (delay > 0) {
        fitTimeout = setTimeout(() => {
          fitTimeout = null
          if (!doFit(force) && force) scheduleFit(isMobileDevice ? 32 : 0, true)
        }, delay)
        return
      }
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null
        doFit(force)
      })
    }
    const scheduleInitialFit = () => {
      if (disposed) return
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (fitTimeout) clearTimeout(fitTimeout)
      fitTimeout = setTimeout(() => {
        fitTimeout = null
        scheduleFit(0, !isMobileDevice)
      }, isMobileDevice ? 80 : 0)
    }
    const forceStableFit = (attempts = attachExclusiveRef.current ? 6 : 4, interval = 34) => {
      if (disposed) return
      stableFitToken += 1
      const token = stableFitToken
      let remaining = Math.max(1, attempts)
      const run = () => {
        if (disposed || token !== stableFitToken) return
        if (attachExclusiveRef.current) {
          scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0, !isMobileDevice)
        } else {
          syncSharedLayout(true)
        }
        remaining -= 1
        if (remaining <= 0) return
        stableFitTimer = setTimeout(run, interval)
      }
      if (stableFitTimer) clearTimeout(stableFitTimer)
      run()
    }
    scheduleFitRef.current = scheduleFit
    forceStableFitRef.current = () => forceStableFit()

    const syncSharedLayout = (resetFont: boolean, attempt = 0) => {
      if (!terminal || disposed || attachExclusiveRef.current) return
      const size = sharedSessionSizeRef.current
      if (!size || size.cols <= 0 || size.rows <= 0) return
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      if (resetFont) {
        applyTerminalOptions()
      } else {
        terminal.options.fontFamily = preferencesRef.current.fontFamily
        terminal.options.cursorBlink = preferencesRef.current.cursorBlink
      }
      if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
        terminal.resize(size.cols, size.rows)
      }
      sharedLayoutFrame = requestAnimationFrame(() => {
        if (disposed) return
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
        repaintTerminalRenderer()
        const prev = lastSizeRef.current
        lastSizeRef.current = { cols: size.cols, rows: size.rows }
        if (!prev || prev.cols !== size.cols || prev.rows !== size.rows) {
          onResizeRef.current?.(size.cols, size.rows)
        }
      })
    }
    syncSharedLayoutRef.current = (rf) => syncSharedLayout(rf)

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')
      if (!container || !container.isConnected || disposed) return
      const style = getComputedStyle(document.documentElement)
      const getVar = (name: string) => style.getPropertyValue(name).trim()
      terminal = new Terminal({
        theme: {
          background: `rgb(${getVar('--bg-1')})`,
          foreground: `rgb(${getVar('--text-1')})`,
          cursor: `rgb(${getVar('--accent')})`,
          selectionBackground: `rgb(${getVar('--accent')} / 0.2)`,
        },
        cursorBlink: preferencesRef.current.cursorBlink,
        cursorStyle: 'bar',
        allowTransparency: false,
        fontSize: preferencesRef.current.fontSize,
        fontFamily: preferencesRef.current.fontFamily,
        letterSpacing: 0,
        lineHeight: 1,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: true,
        scrollback: SCROLLBACK_LIMIT,
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(new WebLinksAddon())
      terminal.open(container)
      if (!isMobileDevice) {
        const { CanvasAddon } = await import('@xterm/addon-canvas')
        terminal.loadAddon(new CanvasAddon())
      }
      recordMobileDebug('terminal-renderer', { renderer: isMobileDevice ? 'dom' : 'canvas' })
      if (terminal.element instanceof HTMLElement) {
        terminal.element.style.width = '100%'
        terminal.element.style.height = '100%'
        const viewport = terminal.element.querySelector('.xterm-viewport') as HTMLElement | null
        if (viewport) {
          viewport.style.scrollbarWidth = 'none'
          viewport.style.setProperty('-ms-overflow-style', 'none')
        }
      }
      fitAddonRef.current = fitAddon
      terminalInstance.current = terminal
      ;(window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal = terminal
      void loadSessionSnapshot()
      const da2Handler = terminal.parser?.registerCsiHandler?.({ prefix: '>', final: 'c' }, () => true)
      if (da2Handler) {
        disposables.push(da2Handler)
      }
      const osc52Handler = terminal.parser?.registerOscHandler?.(52, (data: string) => {
        const sep = data.indexOf(';')
        if (sep < 0) return true
        const base64 = data.slice(sep + 1)
        if (!base64) return true
        try {
          const text = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''))
          navigator.clipboard?.writeText(text)
        } catch {}
        return true
      })
      if (osc52Handler) {
        disposables.push(osc52Handler)
      }
      if (attachExclusiveRef.current) {
        scheduleInitialFit()
      }
      disposables.push(
        terminal.onData((data: string) => {
          onInputRef.current?.(data)
        })
      )
      disposables.push(
        terminal.onSelectionChange(() => {
          const selection = getSelectionText()
          if (!selection) {
            selectionSync.setSelection('')
            return
          }
          selectionSync.setSelection(selection)
          selectionSync.scheduleCopySelection(selection)
        })
      )
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
          const selection = getSelectionText()
          if (selection) {
            selectionSync.runCopySelection(selection, true, true, focusTerminalInput)
            return false
          }
          return true
        }
        if (isPasteShortcut(e)) {
          if (e.repeat) return false
          pasteBridge.scheduleKeyboardPasteFallback(() => terminal?.focus?.())
          return false
        }
        if (e.key === 'Backspace' && e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.repeat || deleteWordRepeatActive) return false
          onInputRef.current?.(DELETE_PREV_WORD_SEQUENCE)
          startDeleteWordRepeat()
          return false
        }
        if (e.key === 'Delete' && e.ctrlKey && !e.metaKey && !e.altKey) {
          onInputRef.current?.(DELETE_NEXT_WORD_SEQUENCE)
          return false
        }
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          onInputRef.current?.('\u001b[3~')
          return false
        }
        return true
      })
      const handleOutput = (event: Event | string | { data: string; sessionName?: string | null }) => {
        const payload = typeof event === 'string' ? { data: event, sessionName: null } : event instanceof Event ? { data: String((event as CustomEvent).detail || ''), sessionName: null } : event
        if (payload.sessionName && payload.sessionName !== sessionNameRef.current) return
        const raw = payload.data
        if (!raw || !terminal?.write) return
        outputSinceLastAttach = true
        controlCarryRef.current = ''
        recordTerminalOutput(useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF, raw, raw.length, 0)
        terminal.write(raw)
        if (!attachExclusiveRef.current && isMobileDevice) requestAnimationFrame(syncSharedViewport)
      }
      const unsubscribeOutput = subscribeOutputRef.current ? subscribeOutputRef.current(handleOutput) : () => {}
      if (!subscribeOutputRef.current) window.addEventListener('tmuxgo-terminal-output', handleOutput as EventListener)
      const handleCopySelection = (event: Event) => {
        const selection = getSelectionText()
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId: (event as CustomEvent).detail?.requestId, selection } }))
      }
      window.addEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
      const handleWindowResize = () => {
        syncRenderEnvironment('window-resize')
        if (!attachExclusiveRef.current) {
          syncSharedLayout(false)
          return
        }
        scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0)
      }
      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Backspace' || !e.ctrlKey) stopDeleteWordRepeat()
      }
      const handleOrientationChange = () => {
        if (attachExclusiveRef.current) {
          scheduleFit(0, true)
          setTimeout(() => scheduleFit(0, true), 120)
        } else {
          syncSharedLayout(true)
          setTimeout(() => syncSharedLayout(true), 120)
        }
        recoverTerminalScreen('orientationchange', true)
        setTimeout(() => recoverTerminalScreen('orientationchange-stable', true), 140)
      }
      const handleKeyboardChange = (event: Event) => {
        if (!attachExclusiveRef.current) return
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        const nextOpen = typeof detail?.open === 'boolean' ? detail.open : document.body.classList.contains('keyboard-open')
        if (nextOpen === lastKeyboardOpen) return
        lastKeyboardOpen = nextOpen
        scheduleFit(0, true)
        setTimeout(() => scheduleFit(0, true), 80)
      }
      const handleAttached = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
        const cols = Number(detail.cols)
        const rows = Number(detail.rows)
        if (!terminal || disposed) return
        const hadOutputBeforeAttach = outputSinceLastAttach
        outputSinceLastAttach = false
        attachEventCount += 1
        const initialAttach = attachEventCount === 1
        const softRecover = initialAttach && hadOutputBeforeAttach
        void loadSessionSnapshot()
        if (attachExclusiveRef.current) {
          scheduleInitialFit()
          if (!isMobileDevice) forceStableFit(5, 34)
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, true)
          else recoverTerminalScreen('attached', true)
          return
        }
        if (cols > 0 && rows > 0) {
          sharedSessionSizeRef.current = { cols, rows }
          syncSharedLayout(true)
          if (!isMobileDevice) forceStableFit(4, 34)
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, true)
          else recoverTerminalScreen('attached', true)
        }
      }
      const handleLayoutChange = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (isMobileDevice && detail.reason === 'attached') return
        const perf = useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF
        updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
        if (detail.reason === 'terminal-panel-resize') {
          if (attachExclusiveRef.current) {
            scheduleFit(0, true)
            scheduleTerminalRepaint([0, 16, 48])
            return
          }
          syncSharedLayout(true)
          scheduleTerminalRepaint([0, 16, 48])
          return
        }
        if (attachExclusiveRef.current) {
          if (isMobileDevice) scheduleFit(MOBILE_FIT_DEBOUNCE_MS)
          else forceStableFit(5, 34)
          scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          return
        }
        if (!isMobileDevice) forceStableFit(4, 34)
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
      }
      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopDeleteWordRepeat()
          return
        }
        const recovered = syncRenderEnvironment('visibilitychange')
        if (attachExclusiveRef.current) {
          if (isMobileDevice) scheduleFit(MOBILE_FIT_DEBOUNCE_MS)
          else forceStableFit(4, 34)
          if (isMobileDevice && !recovered) {
            recoverTerminalScreen('visibilitychange', true)
            return
          }
          if (recovered) return
          scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          return
        }
        if (!isMobileDevice) forceStableFit(3, 34)
        if (isMobileDevice && !recovered) {
          recoverTerminalScreen('visibilitychange', true)
          return
        }
        if (recovered) return
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
      }
      const handlePageShow = () => {
        const recovered = syncRenderEnvironment('pageshow')
        if (attachExclusiveRef.current) scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0, true)
        if (isMobileDevice && !recovered) recoverTerminalScreen('pageshow', true)
      }
      window.addEventListener('tmux-attached', handleAttached as EventListener)
      window.addEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
      window.addEventListener('resize', handleWindowResize)
      window.addEventListener('keyup', handleKeyUp)
      window.addEventListener('blur', stopDeleteWordRepeat)
      window.addEventListener('orientationchange', handleOrientationChange)
      window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
      window.addEventListener('pageshow', handlePageShow)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      const handleDragLeave = (e: DragEvent) => {
        dropState.handleDragLeave(e, container)
      }
      container.addEventListener('mousedown', handlePaneResizeStart, true)
      container.addEventListener('mousemove', handlePaneResizeHover)
      container.addEventListener('mouseleave', clearPaneResizeHover)
      container.addEventListener('dragover', dropState.handleDragOver)
      container.addEventListener('dragleave', handleDragLeave)
      container.addEventListener('drop', dropState.handleDrop)
      const handleCopy = (e: ClipboardEvent) => {
        selectionSync.handleNativeCopyEvent(getSelectionText(), e)
      }
      const helperTextarea = terminal.textarea
      helperTextarea?.addEventListener('copy', handleCopy, true)
      container.addEventListener('copy', handleCopy, true)
      helperTextarea?.addEventListener('paste', pasteBridge.handlePaste, true)
      container.addEventListener('paste', pasteBridge.handlePaste, true)
      container.addEventListener('beforeinput', pasteBridge.handlePasteInput as EventListener, true)
      container.addEventListener('input', pasteBridge.handlePasteInput as EventListener, true)
      const clearPointerSync = () => {
        pointerSyncActive = false
      }
      const armPointerSync = () => {
        pointerSyncActive = true
      }
    const handlePointerSync = () => {
      if (!pointerSyncActive) return
      pointerSyncActive = false
      selectionSync.clearCopySelectionTimer()
      selectionSync.runCopySelection(getSelectionText() || selectionSync.currentSelectionRef.current, true, true, focusTerminalInput)
      void syncActivePane()
    }
      const handleFocusTerminal = () => {
        focusTerminalInput()
        requestAnimationFrame(focusTerminalInput)
        setTimeout(focusTerminalInput, 0)
        setTimeout(focusTerminalInput, 32)
        setTimeout(focusTerminalInput, 96)
      }
      container.addEventListener('mousedown', armPointerSync)
      container.addEventListener('touchstart', armPointerSync, { passive: true })
      window.addEventListener('mouseup', handlePointerSync)
      window.addEventListener('touchend', handlePointerSync)
      window.addEventListener('touchcancel', clearPointerSync)
      window.addEventListener('pointercancel', clearPointerSync)
      window.addEventListener('blur', clearPointerSync)
      window.addEventListener('tmuxgo-focus-terminal', handleFocusTerminal as EventListener)
      disposables.push({
        dispose: () => {
          window.removeEventListener('tmux-attached', handleAttached as EventListener)
          window.removeEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
          unsubscribeOutput()
          if (!subscribeOutputRef.current) window.removeEventListener('tmuxgo-terminal-output', handleOutput as EventListener)
          window.removeEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
          window.removeEventListener('resize', handleWindowResize)
          window.removeEventListener('keyup', handleKeyUp)
          window.removeEventListener('blur', stopDeleteWordRepeat)
          window.removeEventListener('orientationchange', handleOrientationChange)
          window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
          window.removeEventListener('pageshow', handlePageShow)
          document.removeEventListener('visibilitychange', handleVisibilityChange)
          if (paneResizeDrag?.frame) cancelAnimationFrame(paneResizeDrag.frame)
          paneResizeDrag = null
          container.style.cursor = ''
          window.removeEventListener('mousemove', handlePaneResizeMove)
          window.removeEventListener('mouseup', endPaneResizeDrag)
          window.removeEventListener('blur', endPaneResizeDrag)
          container.removeEventListener('mousedown', handlePaneResizeStart, true)
          container.removeEventListener('mousemove', handlePaneResizeHover)
          container.removeEventListener('mouseleave', clearPaneResizeHover)
          container.removeEventListener('dragover', dropState.handleDragOver)
          container.removeEventListener('dragleave', handleDragLeave)
          container.removeEventListener('drop', dropState.handleDrop)
          helperTextarea?.removeEventListener('copy', handleCopy, true)
          container.removeEventListener('copy', handleCopy, true)
          helperTextarea?.removeEventListener('paste', pasteBridge.handlePaste, true)
          container.removeEventListener('paste', pasteBridge.handlePaste, true)
          container.removeEventListener('beforeinput', pasteBridge.handlePasteInput as EventListener, true)
          container.removeEventListener('input', pasteBridge.handlePasteInput as EventListener, true)
          container.removeEventListener('mousedown', armPointerSync)
          container.removeEventListener('touchstart', armPointerSync)
          window.removeEventListener('mouseup', handlePointerSync)
          window.removeEventListener('touchend', handlePointerSync)
          window.removeEventListener('touchcancel', clearPointerSync)
          window.removeEventListener('pointercancel', clearPointerSync)
          window.removeEventListener('blur', clearPointerSync)
          window.removeEventListener('tmuxgo-focus-terminal', handleFocusTerminal as EventListener)
          selectionSync.clearCopySelectionTimer()
          pasteBridge.dispose()
          selectionSync.dispose()
        },
      })
      resizeObserver = new ResizeObserver(() => {
        const width = container.clientWidth
        const height = container.clientHeight
        recordMobileDebug('terminal-resize-observer', { width, height })
        if (Math.abs(width - lastContainerSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(height - lastContainerSize.height) <= MOBILE_FIT_SIZE_TOLERANCE) return
        lastContainerSize = { width, height }
        if (attachExclusiveRef.current) {
          scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0)
          return
        }
        syncSharedLayout(false)
      })
      resizeObserver.observe(container)
      container.addEventListener('touchstart', handlePinchTouchStart, { passive: true })
      container.addEventListener('touchmove', handlePinchTouchMove, { passive: false })
      container.addEventListener('touchend', handlePinchTouchEnd, { passive: true })
      container.addEventListener('touchcancel', handlePinchTouchCancel, { passive: true })
      container.addEventListener('touchstart', touchScroll.handleTouchStart, { passive: true })
      container.addEventListener('touchmove', touchScroll.handleTouchMove, { passive: false })
      container.addEventListener('touchend', touchScroll.handleTouchEnd, { passive: true })
      container.addEventListener('touchcancel', touchScroll.handleTouchCancel, { passive: true })
      disposables.push({
        dispose: () => {
          container.removeEventListener('touchstart', handlePinchTouchStart)
          container.removeEventListener('touchmove', handlePinchTouchMove)
          container.removeEventListener('touchend', handlePinchTouchEnd)
          container.removeEventListener('touchcancel', handlePinchTouchCancel)
          touchScroll.dispose()
          container.removeEventListener('touchstart', touchScroll.handleTouchStart)
          container.removeEventListener('touchmove', touchScroll.handleTouchMove)
          container.removeEventListener('touchend', touchScroll.handleTouchEnd)
          container.removeEventListener('touchcancel', touchScroll.handleTouchCancel)
        },
      })
      if (disposed) return
      if (!attachExclusiveRef.current) {
        notifyReady()
      }
    }
    initTerminal().catch(console.error)
    return () => {
      disposed = true
      stopDeleteWordRepeat()
      if (fitTimeout) clearTimeout(fitTimeout)
      if (stableFitTimer) clearTimeout(stableFitTimer)
      if (fitFrame) cancelAnimationFrame(fitFrame)
      clearTerminalRepaint()
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      resizeObserver?.disconnect()
      disposables.forEach((d) => d?.dispose?.())
      terminal?.dispose()
      terminalInstance.current = null
      fitAddonRef.current = null
      scheduleFitRef.current = () => {}
      forceStableFitRef.current = () => {}
      syncSharedLayoutRef.current = () => {}
    }
  }, [handlePinchTouchCancel, handlePinchTouchEnd, handlePinchTouchMove, handlePinchTouchStart, openUploadDialog, pushToast, queryClient, recordTerminalOutput, selectionSync, setActivePane, touchScroll, updateTerminalPerf])

  return (
    <div
      ref={terminalRef}
      data-terminal
      tabIndex={0}
      className="h-full w-full min-h-0 overflow-hidden relative"
      style={{
        ['--terminal-padding' as any]: `${preferences.terminalPadding}px`,
        ['--terminal-padding-bottom' as any]: `${preferences.terminalPadding}px`,
        touchAction: isMobileDevice ? 'none' : 'auto',
      }}
      onMouseDown={() => {
        if (!isMobileDevice) terminalInstance.current?.focus?.()
      }}
      onFocus={() => {
        if (!isMobileDevice) terminalInstance.current?.focus?.()
      }}
      onTouchEnd={(e) => {
        if (isMobileDevice && !touchMovedRef.current) {
          e.preventDefault()
          const touch = e.changedTouches[0]
          const tap = lastTapRef.current || (touch ? { x: touch.clientX, y: touch.clientY } : null)
          if (tap) dispatchTerminalTap(tap.x, tap.y)
          lastTapRef.current = null
          focusKeyboard()
        } else if (!isMobileDevice) {
          terminalRef.current?.focus()
        }
        touchMovedRef.current = false
      }}
    >
      {dropState.isDropActive && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">{t('terminal.dropUpload')}</div>}
      {isMobileDevice && (
        <textarea
          ref={textareaRef}
          className="mobile-kb-input"
          rows={1}
          inputMode="text"
          enterKeyHint="enter"
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label="Terminal input"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 'calc(var(--mobile-keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px) + 10px)',
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0.01,
            background: 'transparent',
            color: 'transparent',
            pointerEvents: 'none',
            zIndex: 8,
            transform: 'translateX(-50%)',
          }}
        />
      )}
    </div>
  )
}
