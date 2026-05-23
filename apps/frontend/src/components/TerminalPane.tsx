'use client'

import { useEffect, useRef } from 'react'
import { usePreferences } from '@/hooks/usePreferences'

interface TerminalPaneProps {
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
}

export function TerminalPane({ onInput, onResize, attachExclusive = false, onReady }: TerminalPaneProps) {
  const { preferences } = usePreferences()
  const terminalRef = useRef<HTMLDivElement>(null)
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

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')
      await import('@xterm/xterm/css/xterm.css')
      if (!container || !container.isConnected || disposed) return
      terminal = new Terminal({
        theme: {
          background: '#071224',
          foreground: '#E8F3FF',
          cursor: '#1EC8FF',
          selectionBackground: '#1EC8FF33',
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
    }
  }, [])

  return (
    <div
      ref={terminalRef}
      data-terminal
      className="h-full w-full min-h-0 overflow-hidden"
      style={{ ['--terminal-padding' as any]: `${preferences.terminalPadding}px` }}
      onMouseDown={() => terminalInstance.current?.focus?.()}
    />
  )
}
