'use client'

import { useEffect, useRef } from 'react'
import { usePreferences } from '@/hooks/usePreferences'

interface TerminalPaneProps {
  onInput?: (data: string) => void
}

export function TerminalPane({ onInput }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const onInputRef = useRef(onInput)

  useEffect(() => {
    onInputRef.current = onInput
  }, [onInput])

  useEffect(() => {
    if (!terminalRef.current) return

    const container = terminalRef.current
    let terminal: any = null
    let fitAddon: any = null
    let resizeObserver: ResizeObserver | null = null
    let disposables: any[] = []

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')
      await import('@xterm/xterm/css/xterm.css')

      if (!container || !container.isConnected) return

      terminal = new Terminal({
        theme: {
          background: '#071224',
          foreground: '#E8F3FF',
          cursor: '#1EC8FF',
          selectionBackground: '#1EC8FF33',
        },
        cursorBlink: true,
        cursorStyle: 'bar',
        allowTransparency: true,
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(new WebLinksAddon())
      terminal.open(container)
      fitAddon.fit()

      fitAddonRef.current = fitAddon
      terminalInstance.current = terminal

      disposables.push(
        terminal.onData((data: string) => {
          onInputRef.current?.(data)
        })
      )

      const handleOutput = (event: Event) => {
        terminal.write((event as CustomEvent).detail)
      }
      container.addEventListener('terminal-output', handleOutput)

      resizeObserver = new ResizeObserver(() => fitAddon?.fit())
      resizeObserver.observe(container)
    }

    initTerminal()

    return () => {
      resizeObserver?.disconnect()
      disposables.forEach((d) => d.dispose())
      terminal?.dispose()
      terminalInstance.current = null
      fitAddonRef.current = null
    }
  }, [])

  return (
    <div
      ref={terminalRef}
      data-terminal
      className="h-full w-full"
      onMouseDown={() => terminalInstance.current?.focus?.()}
    />
  )
}
