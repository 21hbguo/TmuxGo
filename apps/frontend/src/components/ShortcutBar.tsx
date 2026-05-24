'use client'

import { useRef, useCallback, useState } from 'react'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'

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
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const sessionName = activeSessionId?.replace('session-', '') || ''
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const handleZoom = async () => {
    if (!sessionName) return
    try { await api.panes.zoom(sessionName) } catch {}
  }
  const handleKill = async () => {
    if (!sessionName) return
    try { await api.panes.kill(sessionName) } catch {}
  }

  const sendKey = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1500)
  }, [])

  const startRepeat = useCallback((data: string) => {
    timerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => sendKey(data), REPEAT_INTERVAL)
    }, REPEAT_DELAY)
  }, [sendKey])

  const stopRepeat = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (intervalRef.current) clearInterval(intervalRef.current)
    timerRef.current = null
    intervalRef.current = null
  }, [])

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
      const text = await navigator.clipboard.readText()
      if (text) sendKey(text)
    } catch {
      showToast('Paste failed - long press in terminal')
    }
  }

  const isPanel = mode === 'panel'
  const shellClass = isPanel ? 'relative overflow-hidden rounded-xl border border-[var(--line)] bg-bg-2/60' : 'flex-shrink-0 bg-bg-1 border-t border-[var(--line)] overflow-x-auto scrollbar-none relative'
  const listClass = isPanel ? 'flex flex-wrap gap-1.5 p-2.5' : 'flex gap-1 p-1.5 w-max'
  const baseClass = isPanel ? 'flex min-w-[72px] flex-1 items-center justify-center rounded px-2.5 py-2 text-xs font-mono select-none transition-transform active:scale-95 bg-bg-1 text-text-2 active:bg-accent active:text-bg-0' : 'px-2.5 py-1.5 rounded text-xs font-mono whitespace-nowrap select-none active:scale-95 transition-transform bg-bg-2 text-text-2 active:bg-accent active:text-bg-0'

  return (
    <div {...(isPanel ? {} : { 'data-shortcut-bar': true })} data-keep-mobile-keyboard className={shellClass} style={isPanel ? undefined : { minHeight: 44 }} onContextMenu={(e) => e.preventDefault()}>
      <div
        className={listClass}
        onContextMenu={(e) => e.preventDefault()}
      >
        {keys.map((k) => (
          <button
            key={k.label}
            className={baseClass}
            onPointerDown={() => handleBtn(k)}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
          >
            {k.i18nKey ? t(k.i18nKey as any) : k.label}
          </button>
        ))}
        <div className={`${isPanel ? 'hidden' : 'w-px'} bg-[var(--line)] mx-1 self-stretch`} />
        <button className={baseClass + ' bg-accent/20 text-accent'} onPointerDown={handleCopy}>{t('quick.copy')}</button>
        <button className={baseClass + ' bg-accent/20 text-accent'} onPointerDown={handlePaste}>{t('quick.paste')}</button>
        <div className={`${isPanel ? 'hidden' : 'w-px'} bg-[var(--line)] mx-1 self-stretch`} />
        {tmuxKeys.map((k) => (
          <button
            key={k.label}
            className={baseClass}
            onPointerDown={() => handleBtn(k)}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
          >
            {k.i18nKey ? t(k.i18nKey as any) : k.label}
          </button>
        ))}
        <button className={baseClass} onPointerDown={handleZoom}>{t('shortcut.zoom')}</button>
        <button className={baseClass + ' text-danger'} onPointerDown={handleKill}>{t('shortcut.kill')}</button>
      </div>
      {toast && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full bg-bg-2 text-text-1 text-xs px-3 py-1 rounded-t-lg border border-[var(--line)]">
          {toast}
        </div>
      )}
    </div>
  )
}
