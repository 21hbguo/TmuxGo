'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCustomShortcuts, keysToEscape } from '@/hooks/useCustomShortcuts'
import { AddShortcutModal } from './AddShortcutModal'
import { ConfirmDialog } from './ConfirmDialog'
import { api } from '@/lib/api'
import { writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { DELETE_PREV_LINE_SEQUENCE, DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'

const btn = 'px-2 py-1.5 rounded text-xs transition-colors bg-bg-2 text-text-2 hover:bg-bg-1 active:bg-bg-0'
const repeatBtn = `${btn} touch-none select-none`

export function QuickActions() {
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const [pendingDirection, setPendingDirection] = useState<'horizontal' | 'vertical' | null>(null)
  const activeWindow = useMemo(() => windowsData.find((w: any) => w.active) || windowsData[0] || null, [windowsData])
  const canSplit = !!activePaneId && !!activeWindow && !pendingDirection
  const { send } = useWebSocket()
  const { shortcuts, addShortcut, removeShortcut } = useCustomShortcuts()
  const [showModal, setShowModal] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [confirmKillOpen, setConfirmKillOpen] = useState(false)
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const sendKey = useCallback((data: string) => send({ type: 'input', data }), [send])
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
  const refreshSnapshot = useCallback(async () => {
    if (!activeHostId || !activeSessionId) return
    const snapshot = await api.snapshot.get(activeHostId, activeSessionId)
    useConsoleStore.setState((state) => ({
      windows: snapshot.windows || [],
      panes: snapshot.panes || [],
      activePaneId: (snapshot.panes || []).find((pane: any) => pane.active)?.id || ((snapshot.panes || []).some((pane: any) => pane.id === state.activePaneId) ? state.activePaneId : snapshot.activePaneId || snapshot.panes?.[0]?.id || null),
    }))
  }, [activeHostId, activeSessionId])
  const stopRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])
  const startRepeat = useCallback((data: string) => {
    stopRepeat()
    sendKey(data)
    repeatTimerRef.current = setTimeout(() => {
      repeatIntervalRef.current = setInterval(() => sendKey(data), 54)
    }, 260)
  }, [sendKey, stopRepeat])
  useEffect(() => stopRepeat, [stopRepeat])

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!activeWindow || pendingDirection) return
    setPendingDirection(direction)
    try {
      const paneId = await resolveActivePaneId()
      if (!paneId) throw new Error('No active pane')
      await api.panes.split(paneId, direction)
      await refreshSnapshot()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'split-pane', direction } }))
      pushToast({ type: 'success', message: 'Pane split complete' })
    } catch (err) {
      try {
        await refreshSnapshot()
        const paneId = useConsoleStore.getState().activePaneId
        if (!paneId || paneId === activePaneId) throw err
        await api.panes.split(paneId, direction)
        await refreshSnapshot()
        window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'split-pane', direction } }))
        pushToast({ type: 'success', message: 'Pane split complete' })
      } catch (retryErr) {
        pushToast({ type: 'error', message: retryErr instanceof Error ? retryErr.message : 'Split failed' })
      }
    } finally {
      setPendingDirection(null)
    }
  }

  const handleCopy = () => {
    void requestTerminalSelection().then(async (text) => {
      if (!text) return
      const result = await writeClipboardText(text)
      if (!result.copied) {
        pushToast({ type: 'error', message: 'Copy failed' })
        return
      }
      if (result.unavailable) pushToast({ type: 'info', message: 'Clipboard unavailable, kept in app' })
    })
  }

  const handlePaste = () => window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))

  const handleKillPane = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    useConsoleStore.setState({ activePaneId: paneId })
    setConfirmKillOpen(true)
  }

  const confirmKillPane = async () => {
    const paneId = await resolveActivePaneId()
    if (!paneId) return
    try {
      await api.panes.kill(paneId)
      await refreshSnapshot()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'kill-pane' } }))
      pushToast({ type: 'success', message: 'Pane closed' })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Kill failed' })
    }
    setConfirmKillOpen(false)
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1">
        <button onClick={() => handleSplit('horizontal')} disabled={!canSplit}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${canSplit ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('sidebar.splitH')}
        </button>
        <button onClick={() => handleSplit('vertical')} disabled={!canSplit}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${canSplit ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('sidebar.splitV')}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <button onClick={() => sendKey('\x1b')} className={btn}>Esc</button>
        <button onPointerDown={() => startRepeat('\x1b[A')} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} className={repeatBtn}>&uarr;</button>
        <button onClick={() => sendKey('\t')} className={btn}>Tab</button>
        <button onPointerDown={() => startRepeat('\x1b[D')} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} className={repeatBtn}>&larr;</button>
        <button onPointerDown={() => startRepeat('\x1b[B')} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} className={repeatBtn}>&darr;</button>
        <button onPointerDown={() => startRepeat('\x1b[C')} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} className={repeatBtn}>&rarr;</button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <button onClick={() => sendKey('\x03')} className={btn}>Ctrl+C</button>
        <button onClick={() => sendKey(DELETE_PREV_LINE_SEQUENCE)} className={btn}>{t('quick.clearLine')}</button>
        <button onClick={() => sendKey(DELETE_PREV_WORD_SEQUENCE)} className={btn}>{t('quick.deleteWord')}</button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <button onClick={() => sendKey('\r')} className={btn}>Enter</button>
        <button onClick={() => resolveActivePaneId().then((paneId) => paneId && api.panes.zoomByPane(paneId).then(() => window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'zoom-pane' } })))).catch((err) => pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Zoom failed' }))} disabled={!activePaneId}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${activePaneId ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('quick.zoom')}
        </button>
        <button onClick={() => sendKey('\x7f')} className={btn}>Backspace</button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <button onClick={handleCopy} className={btn}>{t('quick.copy')}</button>
        <button onClick={handlePaste} className={btn}>{t('quick.paste')}</button>
        <button onClick={handleKillPane} disabled={!activePaneId}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${activePaneId ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('quick.killPane')}
        </button>
      </div>

      <button onClick={() => updatePreferences({ attachExclusive: !preferences.attachExclusive })}
        className="w-full px-2 py-1.5 rounded text-xs transition-colors bg-accent/20 text-accent border border-accent/40 hover:bg-accent/25">
        {preferences.attachExclusive ? t('quick.attachExclusive') : t('quick.attachShared')}
      </button>

      {shortcuts.length > 0 && (
        <div className="border-t border-[var(--line)] pt-2">
          <div className="text-text-3 text-[10px] mb-1">{t('shortcut.custom')}</div>
          {shortcuts.map((s) => (
            <div key={s.id} className="group flex items-center gap-1 mb-1">
              <button onClick={() => sendKey(keysToEscape(s.keys))} className={btn + ' flex-1 truncate'} title={s.keys}>
                {s.label}
              </button>
              <button onClick={() => removeShortcut(s.id)}
                className="p-1 rounded text-text-3 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={() => setShowModal(true)}
        className="w-full px-2 py-1.5 rounded text-xs transition-colors border border-dashed border-[var(--line)] text-text-3 hover:text-text-2 hover:border-accent/50">
        + {t('shortcut.add')}
      </button>

      {showModal && (
        <AddShortcutModal
          isMobile={isMobile}
          onSave={(data) => {
            addShortcut(data)
            setShowModal(false)
          }}
          onClose={() => setShowModal(false)}
        />
      )}
      <ConfirmDialog
        open={confirmKillOpen}
        title={t('quick.killTitle')}
        message={t('quick.killConfirm')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setConfirmKillOpen(false)}
        onConfirm={() => void confirmKillPane()}
      />
    </div>
  )
}
