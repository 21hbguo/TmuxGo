'use client'

import { useEffect, useRef, useCallback } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'

interface TerminalPaneProps {
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
}

export function TerminalPane({ onInput, onResize, attachExclusive = false, onReady }: TerminalPaneProps) {
  const { preferences } = usePreferences()
  const terminalRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const touchMovedRef = useRef(false)
  const terminalInstance = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)
  const attachExclusiveRef = useRef(attachExclusive)
  const onReadyRef = useRef(onReady)
  const preferencesRef = useRef(preferences)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const scheduleFitRef = useRef<() => void>(() => {})
  const syncSharedLayoutRef = useRef<(resetFont: boolean) => void>(() => {})

  const { send } = useWebSocket()
  const sendInput = useCallback((data: string) => send({ type: 'input', data }), [send])
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
    let fitTimers: NodeJS.Timeout[] = []
    let disposed = false
    let readyNotified = false

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

    const doFit = () => {
      if (!fitAddon || !terminal || disposed) return
      if (!attachExclusiveRef.current) return
      try {
        applyTerminalOptions()
        const { cols, rows } = fitAddon.proposeDimensions()
        if (cols && rows && cols > 0 && rows > 0) {
          fitAddon.fit()
          const prev = lastSizeRef.current
          if (!prev || prev.cols !== cols || prev.rows !== rows) {
            lastSizeRef.current = { cols, rows }
            onResizeRef.current?.(cols, rows)
          }
          requestAnimationFrame(() => {
            if (disposed || !terminal) return
            terminal.refresh(0, Math.max(0, terminal.rows - 1))
          })
          notifyReady()
        }
      } catch (e) {
      }
    }

    const scheduleFit = () => {
      if (disposed) return
      if (fitTimeout) clearTimeout(fitTimeout)
      fitTimeout = setTimeout(doFit, 50)
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
        const scale = Math.min(available.width / canvas.width, available.height / canvas.height)
        if (!Number.isFinite(scale) || scale <= 0) return
        const currentFontSize = Number(terminal.options.fontSize) || preferencesRef.current.fontSize
        const nextFontSize = Math.max(6, Math.min(72, Math.round(currentFontSize * scale * 10) / 10))
        if (attempt < 2 && Math.abs(scale - 1) > 0.03 && Math.abs(nextFontSize - currentFontSize) > 0.2) {
          terminal.options.fontSize = nextFontSize
          syncSharedLayout(false, attempt + 1)
          return
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
        scheduleFit()
        requestAnimationFrame(() => scheduleFit())
        fitTimers.push(setTimeout(scheduleFit, 0))
        fitTimers.push(setTimeout(scheduleFit, 150))
        fitTimers.push(setTimeout(scheduleFit, 400))
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
          terminal.write(output)
        }
      }
      container.addEventListener('terminal-output', handleOutput)
      const handleWindowResize = () => scheduleFit()
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
      document.addEventListener('visibilitychange', handleVisibilityChange)
      disposables.push({
        dispose: () => {
          window.removeEventListener('tmux-attached', handleAttached as EventListener)
          container.removeEventListener('terminal-output', handleOutput)
          window.removeEventListener('resize', handleWindowResize)
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        },
      })
      resizeObserver = new ResizeObserver(() => {
        if (attachExclusiveRef.current) {
          scheduleFit()
          return
        }
        syncSharedLayout(false)
      })
      resizeObserver.observe(container)
      let lastTouchY = 0
      let touchStartY = 0
      let touchStartX = 0
      let touchMoved = false
      let scrollDirection: 'unknown' | 'vertical' | 'horizontal' = 'unknown'
      const handleTouchStart = (e: TouchEvent) => {
        if (!isMobileDevice) return
        touchStartY = e.touches[0].clientY
        touchStartX = e.touches[0].clientX
        lastTouchY = touchStartY
        touchMoved = false
        scrollDirection = 'unknown'
      }
      const handleTouchMove = (e: TouchEvent) => {
        if (!isMobileDevice) return
        const x = e.touches[0].clientX
        const y = e.touches[0].clientY
        const dx = Math.abs(x - touchStartX)
        const dy = Math.abs(y - touchStartY)
        if (dx < 8 && dy < 8) return
        if (scrollDirection === 'unknown') {
          scrollDirection = dx > dy ? 'horizontal' : 'vertical'
        }
        if (scrollDirection === 'horizontal') return
        touchMoved = true
        const delta = y - lastTouchY
        if (Math.abs(delta) > 1) {
          e.preventDefault()
          terminal.scrollLines(delta > 0 ? 1 : -1)
          lastTouchY = y
        }
      }
      const handleTouchEnd = () => { touchMovedRef.current = touchMoved }
      container.addEventListener('touchstart', handleTouchStart, { passive: true })
      container.addEventListener('touchmove', handleTouchMove, { passive: false })
      container.addEventListener('touchend', handleTouchEnd, { passive: true })
      disposables.push({
        dispose: () => {
          container.removeEventListener('touchstart', handleTouchStart)
          container.removeEventListener('touchmove', handleTouchMove)
          container.removeEventListener('touchend', handleTouchEnd)
        },
      })
      if (disposed) return
      if (!attachExclusiveRef.current) {
        notifyReady()
      }
    }
    initTerminal()
    return () => {
      disposed = true
      if (fitTimeout) clearTimeout(fitTimeout)
      fitTimers.forEach((timer) => clearTimeout(timer))
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
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
      style={{ ['--terminal-padding' as any]: `${preferences.terminalPadding}px` }}
      onMouseDown={() => terminalInstance.current?.focus?.()}
      onTouchEnd={(e) => {
        if (isMobileDevice && !touchMovedRef.current) {
          e.preventDefault()
          focusKeyboard()
        } else if (!isMobileDevice) {
          terminalInstance.current?.focus?.()
        }
        touchMovedRef.current = false
      }}
    >
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
