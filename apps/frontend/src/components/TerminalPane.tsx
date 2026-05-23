'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import type { Pane } from '@/types'
import { usePreferences } from '@/hooks/usePreferences'

interface Window {
  id: string
  sessionId: string
  index: number
  name: string
  active: boolean
}

interface TerminalPaneProps {
  pane: Pane
  isActive: boolean
  onClick: () => void
  onInput?: (data: string) => void
  windows?: Window[]
  activeWindowId?: string
  onWindowChange?: (windowId: string) => void
}

export function TerminalPane({ pane, isActive, onClick, onInput, windows = [], activeWindowId, onWindowChange }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const onInputRef = useRef(onInput)
  const [isReady, setIsReady] = useState(false)
  const { preferences } = usePreferences()

  useEffect(() => {
    onInputRef.current = onInput
  }, [onInput])

  useEffect(() => {
    if (isActive) {
      terminalInstance.current?.focus?.()
    }
  }, [isActive])

  useEffect(() => {
    if (!terminalRef.current) return

    const container = terminalRef.current
    let terminal: any = null
    let fitAddon: any = null
    let resizeObserver: ResizeObserver | null = null
    let disposables: any[] = []

    const initTerminal = async () => {
      try {
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
            black: '#030A14',
            red: '#FF5D6C',
            green: '#00E5B4',
            yellow: '#FFB020',
            blue: '#1EC8FF',
            magenta: '#C792EA',
            cyan: '#89DDFF',
            white: '#E8F3FF',
          },
          fontFamily: preferences.fontFamily,
          fontSize: preferences.fontSize,
          cursorBlink: preferences.cursorBlink,
          cursorStyle: 'bar',
          allowTransparency: true,
        })

        fitAddon = new FitAddon()
        const webLinksAddon = new WebLinksAddon()

        terminal.loadAddon(fitAddon)
        terminal.loadAddon(webLinksAddon)
        terminal.open(container)
        fitAddon.fit()

        fitAddonRef.current = fitAddon
        terminalInstance.current = terminal

        const dataDisposable = terminal.onData((data: string) => {
          if (onInputRef.current) {
            onInputRef.current(data)
          }
        })
        disposables.push(dataDisposable)

        terminal.writeln('\x1b[1;36m╔══════════════════════════════════════════╗\x1b[0m')
        terminal.writeln('\x1b[1;36m║           tmuxU Terminal v0.1            ║\x1b[0m')
        terminal.writeln('\x1b[1;36m╚══════════════════════════════════════════╝\x1b[0m')
        terminal.writeln('')
        terminal.writeln(`\x1b[33mWindow:\x1b[0m ${pane.title}`)
        terminal.writeln(`\x1b[33mSize:\x1b[0m ${pane.size.cols}×${pane.size.rows}`)
        terminal.writeln('')
        terminal.write('\x1b[32m$\x1b[0m ')

        const handleOutput = (event: Event) => {
          const customEvent = event as CustomEvent
          if (terminal) {
            terminal.write(customEvent.detail)
          }
        }

        container.addEventListener('terminal-output', handleOutput)

        resizeObserver = new ResizeObserver(() => {
          if (fitAddon) {
            fitAddon.fit()
          }
        })
        resizeObserver.observe(container)

        setIsReady(true)
      } catch (err) {
        console.error('Failed to initialize terminal:', err)
      }
    }

    initTerminal()

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      disposables.forEach((d) => d.dispose())
      if (terminal) {
        terminal.dispose()
      }
      terminalInstance.current = null
      fitAddonRef.current = null
      setIsReady(false)
    }
  }, [pane.id])

  const currentWindow = windows.find((w) => w.id === activeWindowId) || windows.find((w) => w.active) || windows[0]

  return (
    <div
      data-pane-id={pane.id}
      onClick={onClick}
      tabIndex={0}
      className={`rounded-lg overflow-hidden border transition-all duration-120 h-full ${
        isActive
          ? 'border-accent shadow-glow'
          : 'border-[var(--line)] opacity-80 hover:opacity-100'
      }`}
    >
      <div className="h-8 bg-bg-2 flex items-center px-3 justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-accent text-xs font-mono">#{pane.index}</span>
          {windows.length > 1 ? (
            <select
              value={activeWindowId || currentWindow?.id}
              onChange={(e) => onWindowChange?.(e.target.value)}
              className="bg-transparent text-text-1 text-sm outline-none cursor-pointer min-w-0 flex-1"
            >
              {windows.map((window) => (
                <option key={window.id} value={window.id} className="bg-bg-2">
                  {window.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-text-1 text-sm truncate">{pane.title}</span>
          )}
          {isActive && (
            <span className="text-accent-2 text-xs">●</span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button className="p-1 hover:bg-bg-1 rounded text-text-3 text-xs">◧</button>
          <button className="p-1 hover:bg-bg-1 rounded text-text-3 text-xs">◻</button>
          <button className="p-1 hover:bg-bg-1 rounded text-danger text-xs">×</button>
        </div>
      </div>
      <div ref={terminalRef} onMouseDown={() => terminalInstance.current?.focus?.()} className="h-[calc(100%-32px)] bg-bg-1" style={{ padding: preferences.terminalPadding }} />
    </div>
  )
}
