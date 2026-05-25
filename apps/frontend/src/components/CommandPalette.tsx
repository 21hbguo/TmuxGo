'use client'

import { useState, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { api } from '@/lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'
import { PasteConfirmDialog } from './PasteConfirmDialog'

interface CommandPaletteProps {
  onClose: () => void
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [pendingKillWindow, setPendingKillWindow] = useState<{ id: string; name: string } | null>(null)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { hosts, sessions, windows, activeHostId, activeSessionId, activePaneId, setCommandPalette, setActiveHost, setActiveSession, pushToast } = useConsoleStore()
  const { t } = useTranslation()

  const close = () => {
    setCommandPalette(false)
    onClose()
  }

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const q = query.toLowerCase()
  const activeWindow = windows.find((window: any) => window.active) || windows[0] || null
  const copySelection = async () => {
    const text = window.getSelection()?.toString()
    if (!text) throw new Error('No selection')
    await navigator.clipboard.writeText(text)
  }
  const pasteClipboard = async () => {
    const text = await navigator.clipboard.readText()
    if (!text) throw new Error('Clipboard is empty')
    const analysis = analyzePaste(text)
    if (analysis.requiresConfirm) {
      const meta = []
      if (analysis.hasNewline) meta.push('multi-line')
      if (analysis.hasControlChars) meta.push('control chars')
      if (analysis.isLong) meta.push(`${text.length} chars`)
      setPendingPaste({ text, meta })
      return
    }
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: text } }))
  }
  const items = [
    ...hosts.filter((h: any) => h.name.toLowerCase().includes(q)).map((host: any) => ({ key: `host-${host.id}`, type: 'host', title: host.name, meta: host.address, action: async () => setActiveHost(host.id) })),
    ...sessions.filter((s: any) => s.name.toLowerCase().includes(q)).map((session: any) => ({ key: `session-${session.id}`, type: 'session', title: session.name, meta: t('palette.windows', { count: session.windowCount }), action: async () => setActiveSession(session.id) })),
    ...windows.filter((w: any) => w.name.toLowerCase().includes(q)).map((window: any) => ({ key: `window-${window.id}`, type: 'action', title: `Switch window: ${window.name}`, meta: 'Enter', action: async () => {
      if (!activeHostId || !activeSessionId) return
      const result = await api.windows.select(activeHostId, activeSessionId, window.id)
      if (result.windows) useConsoleStore.setState({ windows: result.windows })
    } })),
    ...['horizontal', 'vertical'].filter((direction) => (`split ${direction}`).includes(q) || q.length === 0).map((direction) => ({ key: `split-${direction}`, type: 'action', title: direction === 'horizontal' ? t('palette.splitHorizontal') : t('palette.splitVertical'), meta: direction === 'horizontal' ? 'Ctrl+Shift+-' : 'Ctrl+Shift+|', action: async () => {
      const paneId = useConsoleStore.getState().activePaneId
      if (!paneId) return
      await api.panes.split(paneId, direction as 'horizontal' | 'vertical')
    } })),
    ...[t('palette.newSession')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'new-session', type: 'action', title: t('palette.newSession'), meta: '+', action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-new-session')) })),
    ...[t('palette.zoomPane')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'zoom-pane', type: 'action', title: t('palette.zoomPane'), meta: 'Z', action: async () => {
      if (!activePaneId) return
      await api.panes.zoomByPane(activePaneId)
    } })),
    ...[t('palette.copySelection')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'copy-selection', type: 'action', title: t('palette.copySelection'), meta: 'Cmd+C', action: copySelection })),
    ...[t('palette.pasteClipboard')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'paste-clipboard', type: 'action', title: t('palette.pasteClipboard'), meta: 'Cmd+V', action: pasteClipboard })),
    ...[t('palette.renameWindow')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'rename-window', type: 'action', title: t('palette.renameWindow'), meta: activeWindow?.name || '', action: async () => {
      if (!activeHostId || !activeSessionId || !activeWindow) return
      const name = window.prompt(t('palette.renameWindow'), activeWindow.name)
      if (!name) return
      const result = await api.windows.rename(activeHostId, activeSessionId, activeWindow.id, name)
      if (result.windows) useConsoleStore.setState({ windows: result.windows })
    } })),
    ...[t('palette.killWindow')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'kill-window', type: 'action', title: t('palette.killWindow'), meta: activeWindow?.name || '', action: async () => {
      if (!activeWindow) return
      setPendingKillWindow({ id: activeWindow.id, name: activeWindow.name })
    } })),
    ...[t('palette.openSettings')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'open-settings', type: 'action', title: t('palette.openSettings'), meta: 'Esc to close', action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')) })),
  ]

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleSelect = async (index: number) => {
    const item = items[index]
    if (!item) return
    try {
      await item.action()
      close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Action failed' })
    }
  }
  const confirmKillWindow = async () => {
    if (!activeHostId || !activeSessionId || !pendingKillWindow) return
    try {
      const result = await api.windows.kill(activeHostId, activeSessionId, pendingKillWindow.id)
      if (result.windows) useConsoleStore.setState({ windows: result.windows })
      setPendingKillWindow(null)
      close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Action failed' })
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[10vh] z-50 p-4" onClick={close}>
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[500px] shadow-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 p-3 border-b border-[var(--line)]">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-text-3 flex-shrink-0">
            <circle cx={11} cy={11} r={8} /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3 text-sm"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIndex((prev) => Math.min(prev + 1, Math.max(items.length - 1, 0)))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIndex((prev) => Math.max(prev - 1, 0))
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSelect(selectedIndex)
              }
            }}
          />
          <button onClick={close} className="text-text-3 hover:text-text-1 active:text-accent p-1 flex-shrink-0">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {items.map((item, index) => (
            <button
              key={item.key}
              onClick={() => void handleSelect(index)}
              className={`w-full px-3 py-2.5 text-left flex items-center justify-between gap-3 ${selectedIndex === index ? 'bg-bg-2' : 'active:bg-bg-2'}`}
            >
              <div>
                <div className="text-text-1 text-sm">{item.title}</div>
                <div className="text-text-3 text-xs">{item.meta}</div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-3">{item.type}</div>
            </button>
          ))}
          {items.length === 0 && (
            <div className="px-3 py-6 text-text-3 text-sm text-center">
              {t('palette.noResults')}
            </div>
          )}
        </div>

        <div className="hidden lg:flex p-2 border-t border-[var(--line)] items-center justify-between text-text-3 text-xs">
          <span>{t('palette.navigate')}</span>
          <span>{t('palette.select')}</span>
          <span>{t('palette.close')}</span>
        </div>
      </div>
      <ConfirmDialog
        open={!!pendingKillWindow}
        title={t('palette.killWindow')}
        message={pendingKillWindow?.name || ''}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingKillWindow(null)}
        onConfirm={() => void confirmKillWindow()}
      />
      <PasteConfirmDialog
        open={!!pendingPaste}
        text={pendingPaste?.text || ''}
        meta={pendingPaste?.meta || []}
        onCancel={() => setPendingPaste(null)}
        onSend={() => {
          if (pendingPaste) {
            window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: pendingPaste.text } }))
          }
          setPendingPaste(null)
        }}
        onEscapeSend={() => {
          if (pendingPaste) {
            window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: escapePaste(pendingPaste.text) } }))
          }
          setPendingPaste(null)
        }}
      />
    </div>
  )
}
