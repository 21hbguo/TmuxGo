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
import { useTerminalTouchScroll } from '@/hooks/useTerminalTouchScroll'

const SCROLLBACK_LIMIT = 600
const DELETE_WORD_REPEAT_DELAY = 140
const DELETE_WORD_REPEAT_SECOND_DELAY = 109
const DELETE_WORD_REPEAT_THIRD_DELAY = 78
const DELETE_WORD_REPEAT_FOURTH_DELAY = 56
const DELETE_WORD_REPEAT_MIN_DELAY = 30
const DEFAULT_TERMINAL_PERF = { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' }
const TERMINAL_REPAINT_DELAYS = [0, 16, 48, 120, 260]
const TERMINAL_ATTACH_REPAINT_DELAYS = [0, 16, 48, 120, 260, 520]

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
  const { preferences } = usePreferences()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const terminalPerf = useConsoleStore((s) => s.terminalPerf)
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
  const terminalPerfRef = useRef(terminalPerf || DEFAULT_TERMINAL_PERF)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const scheduleFitRef = useRef<() => void>(() => {})
  const forceStableFitRef = useRef<() => void>(() => {})
  const syncSharedLayoutRef = useRef<(resetFont: boolean) => void>(() => {})
  const activeHostIdRef = useRef(activeHostId)
  const exclusiveLineHeightRef = useRef(1)
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
  const dropState = useTerminalDrop((data) => onInputRef.current?.(data), openUploadDialog)
  const pasteBridge = useTerminalPasteBridge()
  const selectionSync = useTerminalSelectionSync(pushToast)
  const handleTouchScroll = useCallback((lines: number) => send({ type: 'pane_scroll', sessionName: sessionNameRef.current, lines }), [send])
  const handleTouchTap = useCallback((x: number, y: number) => {
    lastTapRef.current = { x, y }
  }, [])
  const handleTouchMovedChange = useCallback((moved: boolean) => {
    touchMovedRef.current = moved
  }, [])
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
    exclusiveLineHeightRef.current = 1
  }, [sessionName])
  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])
  useEffect(() => {
    terminalPerfRef.current = terminalPerf || DEFAULT_TERMINAL_PERF
  }, [terminalPerf])
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
      scheduleFitRef.current()
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
    let stableFitToken = 0
    let deleteWordRepeatTimer: ReturnType<typeof setTimeout> | null = null
    let deleteWordRepeatActive = false
    let pointerSyncActive = false

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
    const getSelectionText = () => terminal?.getSelection?.() || window.getSelection?.()?.toString() || ''
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
        const snapshot = await api.snapshot.get(hostId, `session-${currentSessionName}`)
        queryClient?.setQueryData(['session-snapshot', hostId, `session-${currentSessionName}`], snapshot)
        if (snapshot.activePaneId) setActivePane(snapshot.activePaneId)
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
      terminal.options.fontSize = fontSize ?? preferencesRef.current.fontSize
      terminal.options.lineHeight = attachExclusiveRef.current && isMobileDevice ? exclusiveLineHeightRef.current : 1
    }
    const clearViewportStyles = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      sharedPanX = 0
      sharedMaxPanX = 0
      element.style.width = '100%'
      element.style.height = '100%'
      element.style.removeProperty('transform')
      element.style.removeProperty('transform-origin')
      element.style.removeProperty('will-change')
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
    const adjustExclusiveLineHeight = () => {
      if (!attachExclusiveRef.current || !isMobileDevice || !terminal) return false
      const screen = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return false
      const available = getAvailableSize()
      const currentHeight = screen.getBoundingClientRect().height
      if (!available.height || !currentHeight) return false
      const next = Math.max(1, Math.min(1.08, Number((exclusiveLineHeightRef.current * available.height / currentHeight).toFixed(4))))
      if (Math.abs(next - exclusiveLineHeightRef.current) < 0.001) return false
      exclusiveLineHeightRef.current = next
      terminal.options.lineHeight = next
      return true
    }

    const doFit = (force = false) => {
      if (!fitAddon || !terminal || disposed) return false
      if (!attachExclusiveRef.current) return false
      try {
        const currentWidth = container.clientWidth
        const currentHeight = container.clientHeight
        if (!force && currentWidth === lastFitSize.width && currentHeight === lastFitSize.height && lastSizeRef.current) {
          syncExclusiveViewport()
          repaintTerminalRenderer()
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
            if (adjustExclusiveLineHeight()) scheduleFit(0, true)
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
        scheduleFit(0, true)
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
          scheduleFit(0, true)
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
      const { CanvasAddon } = await import('@xterm/addon-canvas')
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
      terminal.loadAddon(new CanvasAddon())
      if (terminal.element instanceof HTMLElement) {
        terminal.element.style.width = '100%'
        terminal.element.style.height = '100%'
      }
      fitAddonRef.current = fitAddon
      terminalInstance.current = terminal
      ;(window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal = terminal
      const da2Handler = terminal.parser?.registerCsiHandler?.({ prefix: '>', final: 'c' }, () => true)
      if (da2Handler) {
        disposables.push(da2Handler)
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
          const selection = terminal?.getSelection?.() || ''
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
        controlCarryRef.current = ''
        recordTerminalOutput(terminalPerfRef.current, raw, raw.length, 0)
        terminal.write(raw, () => {
          if (!terminal || disposed) return
          refreshTerminalRows()
        })
        if (!attachExclusiveRef.current && isMobileDevice) requestAnimationFrame(syncSharedViewport)
      }
      const unsubscribeOutput = subscribeOutputRef.current ? subscribeOutputRef.current(handleOutput) : () => {}
      if (!subscribeOutputRef.current) window.addEventListener('tmuxgo-terminal-output', handleOutput as EventListener)
      const handleCopySelection = (event: Event) => {
        const selection = terminal?.getSelection?.() || ''
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId: (event as CustomEvent).detail?.requestId, selection } }))
      }
      window.addEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
      const handleWindowResize = () => {
        scheduleFit()
      }
      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Backspace' || !e.ctrlKey) stopDeleteWordRepeat()
      }
      const handleOrientationChange = () => {
        if (!attachExclusiveRef.current) return
        scheduleFit(0, true)
        setTimeout(() => scheduleFit(0, true), 120)
      }
      const handleKeyboardChange = () => {
        if (!attachExclusiveRef.current) return
        scheduleFit(0, true)
        setTimeout(() => scheduleFit(0, true), 80)
      }
      const handleAttached = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        const cols = Number(detail.cols)
        const rows = Number(detail.rows)
        if (!terminal || disposed) return
        if (attachExclusiveRef.current) {
          scheduleInitialFit()
          forceStableFit(5, 34)
          scheduleTerminalRepaint(TERMINAL_ATTACH_REPAINT_DELAYS, true)
          return
        }
        if (cols > 0 && rows > 0) {
          sharedSessionSizeRef.current = { cols, rows }
          syncSharedLayout(true)
          forceStableFit(4, 34)
          scheduleTerminalRepaint(TERMINAL_ATTACH_REPAINT_DELAYS, true)
        }
      }
      const handleLayoutChange = () => {
        const perf = terminalPerfRef.current
        updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
        if (attachExclusiveRef.current) {
          forceStableFit(5, 34)
          scheduleTerminalRepaint(TERMINAL_REPAINT_DELAYS)
          return
        }
        forceStableFit(4, 34)
        scheduleTerminalRepaint(TERMINAL_REPAINT_DELAYS)
      }
      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopDeleteWordRepeat()
          return
        }
        if (attachExclusiveRef.current) {
          forceStableFit(4, 34)
          scheduleTerminalRepaint(TERMINAL_REPAINT_DELAYS)
          return
        }
        forceStableFit(3, 34)
        scheduleTerminalRepaint(TERMINAL_REPAINT_DELAYS)
      }
      window.addEventListener('tmux-attached', handleAttached as EventListener)
      window.addEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
      window.addEventListener('resize', handleWindowResize)
      window.addEventListener('keyup', handleKeyUp)
      window.addEventListener('blur', stopDeleteWordRepeat)
      window.addEventListener('orientationchange', handleOrientationChange)
      window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      const handleDragLeave = (e: DragEvent) => {
        dropState.handleDragLeave(e, container)
      }
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
          document.removeEventListener('visibilitychange', handleVisibilityChange)
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
        if (width === lastContainerSize.width && height === lastContainerSize.height) return
        lastContainerSize = { width, height }
        if (attachExclusiveRef.current) {
          scheduleFit()
          return
        }
        syncSharedLayout(false)
      })
      resizeObserver.observe(container)
      container.addEventListener('touchstart', touchScroll.handleTouchStart, { passive: true })
      container.addEventListener('touchmove', touchScroll.handleTouchMove, { passive: false })
      container.addEventListener('touchend', touchScroll.handleTouchEnd, { passive: true })
      container.addEventListener('touchcancel', touchScroll.handleTouchCancel, { passive: true })
      disposables.push({
        dispose: () => {
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
  }, [openUploadDialog, pushToast, queryClient, recordTerminalOutput, selectionSync, setActivePane, touchScroll, updateTerminalPerf])

  return (
    <div
      ref={terminalRef}
      data-terminal
      tabIndex={0}
      className="h-full w-full min-h-0 overflow-hidden relative"
      style={{
        ['--terminal-padding' as any]: `${preferences.terminalPadding}px`,
        ['--terminal-padding-bottom' as any]: isMobileDevice ? '0px' : `${preferences.terminalPadding}px`,
      }}
      onMouseDown={() => terminalInstance.current?.focus?.()}
      onFocus={() => terminalInstance.current?.focus?.()}
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
      {dropState.isDropActive && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">Drop files to upload</div>}
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
