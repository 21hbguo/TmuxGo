'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { formatDroppedPaths } from '@/lib/path-drop'

interface TerminalPaneProps {
  sessionName?: string
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
}

export function TerminalPane({ sessionName, onInput, onResize, attachExclusive = false, onReady }: TerminalPaneProps) {
  const { preferences } = usePreferences()
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
  const [isDropActive, setIsDropActive] = useState(false)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const scheduleFitRef = useRef<() => void>(() => {})
  const syncSharedLayoutRef = useRef<(resetFont: boolean) => void>(() => {})
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
  const sendInput = useCallback((data: string) => onInputRef.current?.(data), [])
  const { textareaRef, focusKeyboard, isMobile: isMobileDevice } = useMobileKeyboard(sendInput, terminalRef)

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
    let sharedLayoutFrame: number | null = null
    let fitFrame: number | null = null
    let outputFrame: number | null = null
    let outputTimer: ReturnType<typeof setTimeout> | null = null
    let outputBuffer = ''
    let disposed = false
    let readyNotified = false
    let sharedPanX = 0
    let sharedMaxPanX = 0

    const notifyReady = () => {
      if (disposed || readyNotified) return
      readyNotified = true
      onReadyRef.current?.()
    }

    const getCanvasSize = () => {
      const canvas = terminal?._core?._renderService?.dimensions?.css?.canvas
      if (!canvas?.width || !canvas?.height) return null
      return { width: canvas.width, height: canvas.height }
    }
    const getFitDimensions = () => {
      if (!terminal?.element?.parentElement) return null
      const dims = terminal?._core?._renderService?.dimensions?.css
      const cellWidth = dims?.cell?.width
      const cellHeight = dims?.cell?.height
      if (!cellWidth || !cellHeight) return null
      const scrollbar = terminal.options.scrollback === 0 ? 0 : terminal._core.viewport.scrollBarWidth
      const parentStyle = window.getComputedStyle(terminal.element.parentElement)
      const terminalStyle = window.getComputedStyle(terminal.element)
      const parentHeight = parseInt(parentStyle.getPropertyValue('height'))
      const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue('width')))
      const paddingY = parseInt(terminalStyle.getPropertyValue('padding-top')) + parseInt(terminalStyle.getPropertyValue('padding-bottom'))
      const paddingX = parseInt(terminalStyle.getPropertyValue('padding-left')) + parseInt(terminalStyle.getPropertyValue('padding-right'))
      const availableHeight = Math.max(0, parentHeight - paddingY)
      const availableWidth = Math.max(0, parentWidth - paddingX - scrollbar)
      const cols = Math.max(2, Math.floor(availableWidth / cellWidth))
      const rows = Math.max(1, Math.floor(availableHeight / cellHeight))
      return { cols, rows }
    }

    const getAvailableSize = () => {
      const padding = preferencesRef.current.terminalPadding * 2
      return {
        width: Math.max(1, container.clientWidth - padding),
        height: Math.max(1, container.clientHeight - padding),
      }
    }

    const applyTerminalOptions = (fontSize?: number) => {
      if (!terminal || disposed) return
      terminal.options.fontFamily = preferencesRef.current.fontFamily
      terminal.options.cursorBlink = preferencesRef.current.cursorBlink
      terminal.options.fontSize = fontSize ?? preferencesRef.current.fontSize
    }
    const clearViewportStyles = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      sharedPanX = 0
      sharedMaxPanX = 0
      element.style.removeProperty('width')
      element.style.removeProperty('height')
      element.style.removeProperty('transform')
      element.style.removeProperty('transform-origin')
      element.style.removeProperty('will-change')
    }
    const syncExclusiveViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (!isMobileDevice || !attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      const canvas = getCanvasSize()
      if (!canvas) return
      const available = getAvailableSize()
      const slackY = Math.max(0, available.height - canvas.height)
      element.style.transform = slackY > 0 ? `translate3d(0,${slackY}px,0)` : 'translate3d(0,0,0)'
      element.style.transformOrigin = 'top left'
      if (slackY > 0) {
        element.style.willChange = 'transform'
      } else {
        element.style.removeProperty('will-change')
      }
    }
    const syncSharedViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (!isMobileDevice || attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      const canvas = getCanvasSize()
      if (!canvas) return
      const available = getAvailableSize()
      const maxPanX = Math.max(0, canvas.width - available.width)
      const maxPanY = Math.max(0, canvas.height - available.height)
      sharedMaxPanX = maxPanX
      sharedPanX = Math.min(sharedPanX, maxPanX)
      element.style.width = `${canvas.width}px`
      element.style.height = `${canvas.height}px`
      element.style.transform = `translate3d(${-sharedPanX}px,${-maxPanY}px,0)`
      element.style.transformOrigin = 'top left'
      if (maxPanX > 0 || maxPanY > 0) {
        element.style.willChange = 'transform'
      } else {
        element.style.removeProperty('will-change')
      }
    }

    const doFit = () => {
      if (!fitAddon || !terminal || disposed) return
      if (!attachExclusiveRef.current) return
      try {
        applyTerminalOptions()
        const size = getFitDimensions() || fitAddon.proposeDimensions()
        if (!size) return
        const { cols, rows } = size
        if (cols && rows && cols > 0 && rows > 0) {
          if (terminal.cols !== cols || terminal.rows !== rows) {
            terminal._core._renderService.clear()
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
            terminal.refresh(0, Math.max(0, terminal.rows - 1))
          })
          notifyReady()
        }
      } catch (e) {
      }
    }
    const flushOutput = () => {
      outputFrame = null
      if (!terminal || disposed || !outputBuffer) return
      const chunk = outputBuffer
      outputBuffer = ''
      terminal.write(chunk)
      if (!attachExclusiveRef.current && isMobileDevice) {
        requestAnimationFrame(syncSharedViewport)
      }
    }
    const scheduleOutputFlush = () => {
      if (outputFrame || disposed) return
      outputFrame = requestAnimationFrame(flushOutput)
    }

    const scheduleFit = () => {
      if (disposed) return
      if (fitTimeout) clearTimeout(fitTimeout)
      fitTimeout = setTimeout(doFit, isMobileDevice ? 220 : 50)
    }
    const scheduleInitialFit = () => {
      if (disposed) return
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (fitTimeout) clearTimeout(fitTimeout)
      fitFrame = requestAnimationFrame(() => {
        fitFrame = requestAnimationFrame(() => {
          doFit()
        })
      })
    }
    scheduleFitRef.current = scheduleFit

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
      terminal.resize(size.cols, size.rows)
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
        if (isMobileDevice) {
          syncSharedViewport()
        }
        lastSizeRef.current = { cols: size.cols, rows: size.rows }
        onResizeRef.current?.(size.cols, size.rows)
      })
    }
    syncSharedLayoutRef.current = (rf) => syncSharedLayout(rf)

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')
      await import('@xterm/xterm/css/xterm.css')
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
        allowTransparency: true,
        fontSize: preferencesRef.current.fontSize,
        fontFamily: preferencesRef.current.fontFamily,
        macOptionIsMeta: true,
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(new WebLinksAddon())
      terminal.open(container)
      fitAddonRef.current = fitAddon
      terminalInstance.current = terminal
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
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          onInputRef.current?.('\u001b[3~')
          return false
        }
        return true
      })
      const handleOutput = (event: Event) => {
        const raw = String((event as CustomEvent).detail || '')
        const merged = controlCarryRef.current + raw
        const cleaned = merged
          .replace(/\u001b\[[0-9;?]*c/g, '')
          .replace(/(?:\u001b\[)?\??(?:\d+;)+\d+c/g, '')
          .replace(/0;(?:\d+;)*\d+c/g, '')
        const tailMatch = merged.match(/(?:\u001b\[[0-9;?]*)?$/)
        controlCarryRef.current = tailMatch ? tailMatch[0] : ''
        const output = controlCarryRef.current ? cleaned.slice(0, cleaned.length - controlCarryRef.current.length) : cleaned
        if (output) {
          outputBuffer += output
          if (outputBuffer.length >= 32768) {
            if (outputTimer) {
              clearTimeout(outputTimer)
              outputTimer = null
            }
            flushOutput()
          } else {
            scheduleOutputFlush()
            if (!outputTimer) {
              outputTimer = setTimeout(() => {
                outputTimer = null
                flushOutput()
              }, 14)
            }
          }
        }
      }
      container.addEventListener('terminal-output', handleOutput)
      const handleWindowResize = () => {
        if (isMobileDevice && attachExclusiveRef.current) return
        scheduleFit()
      }
      const handleOrientationChange = () => {
        if (!attachExclusiveRef.current) return
        setTimeout(() => scheduleFit(), 90)
      }
      const handleKeyboardChange = () => {
        if (!attachExclusiveRef.current) return
        setTimeout(() => scheduleFit(), 60)
      }
      const handleAttached = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        const cols = Number(detail.cols)
        const rows = Number(detail.rows)
        if (!terminal || disposed) return
        if (attachExclusiveRef.current) {
          scheduleFit()
          return
        }
        if (cols > 0 && rows > 0) {
          sharedSessionSizeRef.current = { cols, rows }
          syncSharedLayout(true)
        }
      }
      const handleVisibilityChange = () => {
        if (document.hidden) return
        if (attachExclusiveRef.current) {
          scheduleFit()
          return
        }
        syncSharedLayout(false)
      }
      window.addEventListener('tmux-attached', handleAttached as EventListener)
      window.addEventListener('resize', handleWindowResize)
      window.addEventListener('orientationchange', handleOrientationChange)
      window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      const handleDragOver = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDropActive(true)
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }
      const handleDragLeave = (e: DragEvent) => {
        if (!container.contains(e.relatedTarget as Node | null)) setIsDropActive(false)
      }
      const handleDrop = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDropActive(false)
        const text = formatDroppedPaths(e.dataTransfer)
        if (text) onInputRef.current?.(text)
      }
      container.addEventListener('dragover', handleDragOver)
      container.addEventListener('dragleave', handleDragLeave)
      container.addEventListener('drop', handleDrop)
      disposables.push({
        dispose: () => {
          window.removeEventListener('tmux-attached', handleAttached as EventListener)
          container.removeEventListener('terminal-output', handleOutput)
          window.removeEventListener('resize', handleWindowResize)
          window.removeEventListener('orientationchange', handleOrientationChange)
          window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
          document.removeEventListener('visibilitychange', handleVisibilityChange)
          container.removeEventListener('dragover', handleDragOver)
          container.removeEventListener('dragleave', handleDragLeave)
          container.removeEventListener('drop', handleDrop)
        },
      })
      resizeObserver = new ResizeObserver(() => {
        if (isMobileDevice && attachExclusiveRef.current) return
        if (attachExclusiveRef.current) {
          scheduleFit()
          return
        }
        syncSharedLayout(false)
      })
      resizeObserver.observe(container)
      {
        let startY = 0
        let startX = 0
        let lastY = 0
        let carryY = 0
        let moved = false
        let direction: 'unknown' | 'vertical' | 'horizontal' = 'unknown'
        let scrollPendingLines = 0
        let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null
        let momentumId = 0
        let startTime = 0
        let lastMoveTime = 0
        let lastVelocity = 0
        const FLUSH_INTERVAL = 16
        const MAX_LINES_PER_FLUSH = 18
        const SCROLL_THRESHOLD = 18
        const TAP_THRESHOLD = 10
        const MIN_VELOCITY = 0.2
        const MAX_VELOCITY_LINES = 6
        let momentumTimer: ReturnType<typeof setTimeout> | null = null

        const flushScroll = () => {
          scrollFlushTimer = null
          const lines = Math.trunc(scrollPendingLines)
          scrollPendingLines = 0
          if (!lines) return
          const clamped = Math.max(-MAX_LINES_PER_FLUSH, Math.min(MAX_LINES_PER_FLUSH, lines))
          send({ type: 'pane_scroll', sessionName: sessionNameRef.current, lines: clamped })
        }

        const queueScroll = (lines: number) => {
          scrollPendingLines += lines
          if (!scrollFlushTimer) {
            scrollFlushTimer = setTimeout(flushScroll, FLUSH_INTERVAL)
          }
        }

        const clearMomentum = () => {
          momentumId++
          if (momentumTimer) {
            clearTimeout(momentumTimer)
            momentumTimer = null
          }
        }

        const handleTouchStart = (e: TouchEvent) => {
          if (!isMobileDevice) return
          lastTapRef.current = null
          clearMomentum()
          if (scrollFlushTimer) {
            clearTimeout(scrollFlushTimer)
            scrollFlushTimer = null
          }
          scrollPendingLines = 0
          carryY = 0
          startY = e.touches[0].clientY
          startX = e.touches[0].clientX
          lastY = startY
          startTime = performance.now()
          lastMoveTime = startTime
          lastVelocity = 0
          moved = false
          direction = 'unknown'
        }

        const handleTouchMove = (e: TouchEvent) => {
          if (!isMobileDevice) return
          const x = e.touches[0].clientX
          const y = e.touches[0].clientY
          const dx = Math.abs(x - startX)
          const dy = Math.abs(y - startY)
          if (dx < 8 && dy < 8) return
          if (direction === 'unknown') {
            direction = dx > dy ? 'horizontal' : 'vertical'
          }
          if (direction !== 'vertical') return
          if (dy < TAP_THRESHOLD) return
          moved = true
          e.preventDefault()
          const now = performance.now()
          const deltaY = y - lastY
          const deltaTime = Math.max(1, now - lastMoveTime)
          lastY = y
          lastMoveTime = now
          carryY += deltaY
          lastVelocity = deltaY / deltaTime
          const step = Math.trunc(carryY / SCROLL_THRESHOLD)
          if (step !== 0) {
            carryY -= step * SCROLL_THRESHOLD
            queueScroll(step * 2)
          }
        }

        const handleTouchEnd = (e: TouchEvent) => {
          if (scrollFlushTimer) {
            clearTimeout(scrollFlushTimer)
            scrollFlushTimer = null
          }
          if (scrollPendingLines) flushScroll()
          touchMovedRef.current = moved
          if (direction !== 'vertical') return
          const touch = e.changedTouches[0]
          if (!touch) return
          const totalDx = Math.abs(touch.clientX - startX)
          const totalDy = Math.abs(touch.clientY - startY)
          if (totalDx < TAP_THRESHOLD && totalDy < TAP_THRESHOLD && performance.now() - startTime < 250) {
            lastTapRef.current = { x: touch.clientX, y: touch.clientY }
            return
          }
          let velocity = lastVelocity
          if (Math.abs(velocity) < MIN_VELOCITY) return
          const id = ++momentumId
          const decay = () => {
            if (momentumId !== id) return
            velocity *= 0.92
            if (Math.abs(velocity) < MIN_VELOCITY) {
              momentumTimer = null
              return
            }
            const lines = Math.max(-MAX_VELOCITY_LINES, Math.min(MAX_VELOCITY_LINES, Math.round(velocity * 8)))
            if (lines !== 0) {
              send({ type: 'pane_scroll', sessionName: sessionNameRef.current, lines })
            }
            momentumTimer = setTimeout(decay, FLUSH_INTERVAL)
          }
          momentumTimer = setTimeout(decay, FLUSH_INTERVAL)
        }

        const handleTouchCancel = () => {
          if (scrollFlushTimer) {
            clearTimeout(scrollFlushTimer)
            scrollFlushTimer = null
          }
          clearMomentum()
          scrollPendingLines = 0
          carryY = 0
          moved = false
          direction = 'unknown'
          lastTapRef.current = null
          touchMovedRef.current = false
        }

        container.addEventListener('touchstart', handleTouchStart, { passive: true })
        container.addEventListener('touchmove', handleTouchMove, { passive: false })
        container.addEventListener('touchend', handleTouchEnd, { passive: true })
        container.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        disposables.push({
          dispose: () => {
            if (scrollFlushTimer) clearTimeout(scrollFlushTimer)
            if (momentumTimer) clearTimeout(momentumTimer)
            container.removeEventListener('touchstart', handleTouchStart)
            container.removeEventListener('touchmove', handleTouchMove)
            container.removeEventListener('touchend', handleTouchEnd)
            container.removeEventListener('touchcancel', handleTouchCancel)
          },
        })
      }
      if (disposed) return
      if (!attachExclusiveRef.current) {
        notifyReady()
      }
    }
    initTerminal().catch(console.error)
    return () => {
      disposed = true
      if (fitTimeout) clearTimeout(fitTimeout)
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      if (outputTimer) clearTimeout(outputTimer)
      if (outputFrame) cancelAnimationFrame(outputFrame)
      resizeObserver?.disconnect()
      disposables.forEach((d) => d?.dispose?.())
      terminal?.dispose()
      terminalInstance.current = null
      fitAddonRef.current = null
      scheduleFitRef.current = () => {}
      syncSharedLayoutRef.current = () => {}
    }
  }, [])

  return (
    <div
      ref={terminalRef}
      data-terminal
      className="h-full w-full min-h-0 overflow-hidden relative"
      style={{
        ['--terminal-padding' as any]: `${preferences.terminalPadding}px`,
        ['--terminal-padding-bottom' as any]: isMobileDevice ? '0px' : `${preferences.terminalPadding}px`,
      }}
      onMouseDown={() => terminalInstance.current?.focus?.()}
      onTouchEnd={(e) => {
        if (isMobileDevice && !touchMovedRef.current) {
          e.preventDefault()
          const touch = e.changedTouches[0]
          const tap = lastTapRef.current || (touch ? { x: touch.clientX, y: touch.clientY } : null)
          if (tap) dispatchTerminalTap(tap.x, tap.y)
          lastTapRef.current = null
          focusKeyboard()
        } else if (!isMobileDevice) {
          terminalInstance.current?.focus?.()
        }
        touchMovedRef.current = false
      }}
    >
      {isDropActive && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">Drop to insert path</div>}
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
