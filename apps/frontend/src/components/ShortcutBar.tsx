'use client'

import { useEffect, useRef, useCallback, useState, type PointerEvent } from 'react'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { PasteConfirmDialog } from './PasteConfirmDialog'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'
import { readClipboardTextOnly } from '@/lib/clipboard-text'

interface KeyDef {
  label: string
  i18nKey?: string
  data: string
  repeat?: boolean
}

const keys: KeyDef[] = [
  { label: '↑', data: '\x1b[A', repeat: true },
  { label: '↓', data: '\x1b[B', repeat: true },
  { label: '←', data: '\x1b[D', repeat: true },
  { label: '→', data: '\x1b[C', repeat: true },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'S-Tab', data: '\x1b[Z' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Enter', data: '\r', i18nKey: 'shortcut.enter' },
]

const tmuxKeys: KeyDef[] = [
  { label: '\u2500 Split', data: '\x02%', i18nKey: 'shortcut.splitH' },
  { label: '\u2502 Split', data: '\x02"', i18nKey: 'shortcut.splitV' },
]

const REPEAT_DELAY = 400
const REPEAT_INTERVAL = 80

interface ShortcutBarProps {
  mode?: 'dock' | 'panel'
}

export function ShortcutBar({ mode = 'dock' }: ShortcutBarProps) {
  const { send } = useWebSocket()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[]; mode?: 'confirm' | 'manual' } | null>(null)

  const resolveActivePaneId = useCallback(async () => {
    if (!activeHostId || !activeSessionId) return useConsoleStore.getState().activePaneId
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    const paneId = snapshot.activePaneId || (snapshot.panes || []).find((pane: any) => pane.active)?.id || useConsoleStore.getState().activePaneId
    useConsoleStore.setState((state) => ({
      windows: snapshot.windows || state.windows,
      panes: snapshot.panes || state.panes,
      activePaneId: paneId || state.activePaneId,
    }))
    return paneId
  }, [activeHostId, activeSessionId])
  const handleZoom = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    try {
      await api.panes.zoomByPane(paneId)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'zoom-pane' } }))
    } catch {}
  }
  const handleKill = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    try {
      await api.panes.kill(paneId)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'kill-pane' } }))
    } catch {}
  }

  const sendKey = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1500)
  }, [])
  const preventFocus = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
  }, [])

  const stopRepeat = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (intervalRef.current) clearInterval(intervalRef.current)
    timerRef.current = null
    intervalRef.current = null
  }, [])
  const startRepeat = useCallback((data: string) => {
    stopRepeat()
    timerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => sendKey(data), REPEAT_INTERVAL)
    }, REPEAT_DELAY)
  }, [sendKey, stopRepeat])
  useEffect(() => {
    window.addEventListener('pointerup', stopRepeat)
    window.addEventListener('pointercancel', stopRepeat)
    window.addEventListener('touchend', stopRepeat)
    window.addEventListener('touchcancel', stopRepeat)
    window.addEventListener('blur', stopRepeat)
    document.addEventListener('visibilitychange', stopRepeat)
    return () => {
      stopRepeat()
      window.removeEventListener('pointerup', stopRepeat)
      window.removeEventListener('pointercancel', stopRepeat)
      window.removeEventListener('touchend', stopRepeat)
      window.removeEventListener('touchcancel', stopRepeat)
      window.removeEventListener('blur', stopRepeat)
      document.removeEventListener('visibilitychange', stopRepeat)
    }
  }, [stopRepeat])

  const handleBtn = (def: KeyDef) => {
    sendKey(def.data)
    if (def.repeat) startRepeat(def.data)
  }

  const handleCopy = async () => {
    try {
      const sel = window.getSelection()?.toString()
      const text = sel || ''
      if (!text) {
        showToast('No selection')
        return
      }
      await navigator.clipboard.writeText(text)
      showToast('Copied')
    } catch {
      const text = window.getSelection()?.toString() || ''
      if (text) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        showToast('Copied')
      }
    }
  }

  const handlePaste = async () => {
    try {
      const text = await readClipboardTextOnly()
      if (!text) return
      const analysis = analyzePaste(text)
      if (analysis.requiresConfirm) {
        const meta = []
        if (analysis.hasNewline) meta.push('multi-line')
        if (analysis.hasControlChars) meta.push('control chars')
        if (analysis.isLong) meta.push(`${text.length} chars`)
        setPendingPaste({ text, meta })
        return
      }
      sendKey(text)
    } catch {
      setPendingPaste({ text: '', meta: ['clipboard unavailable'], mode: 'manual' })
      showToast('Paste failed')
    }
  }

  const isPanel = mode === 'panel'
  const isDock = mode === 'dock'
  const shellClass = isPanel ? 'relative overflow-hidden rounded-xl border border-[var(--line)] bg-bg-2/60' : isDock ? 'mobile-nav-landscape-hide h-full bg-bg-1 border-t border-[var(--line)] overflow-x-auto scrollbar-none pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(0,0,0,0.28)]' : 'mobile-nav-landscape-hide relative z-40 flex-shrink-0 bg-bg-1 border-t border-[var(--line)] overflow-x-auto scrollbar-none pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(0,0,0,0.28)]'
  const listClass = isPanel ? 'flex flex-wrap gap-1.5 p-2.5' : 'flex gap-1 p-1.5 w-max min-h-[40px] items-center'
  const baseClass = isPanel ? 'flex min-w-[72px] flex-1 items-center justify-center rounded px-2.5 py-2 text-xs font-mono select-none transition-transform active:scale-95 bg-bg-1 text-text-2 active:bg-accent active:text-bg-0' : 'px-2.5 py-1.5 rounded-md text-[11px] leading-none font-mono whitespace-nowrap select-none active:scale-95 transition-transform bg-bg-2 text-text-2 active:bg-accent active:text-bg-0'

  return (
    <div {...(isPanel ? {} : { 'data-shortcut-bar': true })} data-keep-mobile-keyboard className={shellClass} style={isPanel ? undefined : { minHeight: 40 }} onContextMenu={(e) => e.preventDefault()}>
      <div
        className={listClass}
        onContextMenu={(e) => e.preventDefault()}
      >
        {keys.map((k) => (
          <button
            key={k.label}
            type="button"
            tabIndex={-1}
            className={baseClass}
            onPointerDown={(e) => {
              preventFocus(e)
              handleBtn(k)
            }}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
          >
            {k.i18nKey ? t(k.i18nKey as any) : k.label}
          </button>
        ))}
        <div className={`${isPanel ? 'hidden' : 'w-px'} bg-[var(--line)] mx-1 self-stretch`} />
        <button type="button" tabIndex={-1} className={baseClass + ' bg-accent/20 text-accent'} onPointerDown={(e) => {
          preventFocus(e)
          handleCopy()
        }}>{t('quick.copy')}</button>
        <button type="button" tabIndex={-1} className={baseClass + ' bg-accent/20 text-accent'} onPointerDown={(e) => {
          preventFocus(e)
          handlePaste()
        }}>{t('quick.paste')}</button>
        <div className={`${isPanel ? 'hidden' : 'w-px'} bg-[var(--line)] mx-1 self-stretch`} />
        {tmuxKeys.map((k) => (
          <button
            key={k.label}
            type="button"
            tabIndex={-1}
            className={baseClass}
            onPointerDown={(e) => {
              preventFocus(e)
              handleBtn(k)
            }}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
          >
            {k.i18nKey ? t(k.i18nKey as any) : k.label}
          </button>
        ))}
        <button type="button" tabIndex={-1} className={baseClass} onPointerDown={(e) => {
          preventFocus(e)
          handleZoom()
        }}>{t('shortcut.zoom')}</button>
        <button type="button" tabIndex={-1} className={baseClass + ' text-danger'} onPointerDown={(e) => {
          preventFocus(e)
          handleKill()
        }}>{t('shortcut.kill')}</button>
      </div>
      {toast && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full bg-bg-2 text-text-1 text-xs px-3 py-1 rounded-t-lg border border-[var(--line)]">
          {toast}
        </div>
      )}
      <PasteConfirmDialog
        open={!!pendingPaste}
        text={pendingPaste?.text || ''}
        meta={pendingPaste?.meta || []}
        mode={pendingPaste?.mode}
        onTextChange={(text) => setPendingPaste((current) => current ? { ...current, text } : current)}
        onRetryPermission={() => void handlePaste()}
        onCancel={() => setPendingPaste(null)}
        onSend={() => {
          if (pendingPaste) sendKey(pendingPaste.text)
          setPendingPaste(null)
        }}
        onEscapeSend={() => {
          if (pendingPaste) sendKey(escapePaste(pendingPaste.text))
          setPendingPaste(null)
        }}
      />
    </div>
  )
}
