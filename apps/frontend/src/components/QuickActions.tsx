'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCustomShortcuts, keysToEscape } from '@/hooks/useCustomShortcuts'
import { AddShortcutModal } from './AddShortcutModal'
import { ConfirmDialog } from './ConfirmDialog'
import { PasteConfirmDialog } from './PasteConfirmDialog'
import { api } from '@/lib/api'
import { analyzePaste, escapePaste } from '@/lib/paste-safety'

const btn = 'px-2 py-1.5 rounded text-xs transition-colors bg-bg-2 text-text-2 hover:bg-bg-1 active:bg-bg-0'

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
  const [pendingPaste, setPendingPaste] = useState<{ text: string; meta: string[]; mode?: 'confirm' | 'manual' } | null>(null)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const sendKey = (data: string) => send({ type: 'input', data })
  const sendClipboardText = (text: string) => send({ type: 'input', data: text })

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!activePaneId || !activeWindow || pendingDirection) return
    setPendingDirection(direction)
    try {
      await api.panes.split(activePaneId, direction)
      pushToast({ type: 'success', message: 'Pane split complete' })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Split failed' })
    } finally {
      setPendingDirection(null)
    }
  }

  const handleCopy = () => {
    const text = window.getSelection()?.toString()
    if (!text) return
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    } else {
      fallbackCopy(text)
    }
  }

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }

  const handlePaste = async () => {
    try {
      let text = ''
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText()
      } else {
        const ta = document.createElement('textarea')
        ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta)
        ta.focus()
        document.execCommand('paste')
        text = ta.value
        document.body.removeChild(ta)
      }
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
      sendClipboardText(text)
    } catch (err) {
      setPendingPaste({ text: '', meta: ['clipboard unavailable'], mode: 'manual' })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Paste failed' })
    }
  }

  const handleKillPane = async () => {
    if (!activePaneId) return
    setConfirmKillOpen(true)
  }

  const confirmKillPane = async () => {
    if (!activePaneId) return
    try {
      await api.panes.kill(activePaneId)
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
        <button onClick={() => sendKey('\x1b[A')} className={btn}>&uarr;</button>
        <button onClick={() => sendKey('\t')} className={btn}>Tab</button>
        <button onClick={() => sendKey('\x1b[D')} className={btn}>&larr;</button>
        <button onClick={() => sendKey('\x1b[B')} className={btn}>&darr;</button>
        <button onClick={() => sendKey('\x1b[C')} className={btn}>&rarr;</button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <button onClick={() => sendKey('\x03')} className={btn}>Ctrl+C</button>
        <button onClick={() => sendKey('\r')} className={btn}>Enter</button>
        <button onClick={() => activePaneId && api.panes.zoomByPane(activePaneId).catch((err) => pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Zoom failed' }))} disabled={!activePaneId}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${activePaneId ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('quick.zoom')}
        </button>
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
      <PasteConfirmDialog
        open={!!pendingPaste}
        text={pendingPaste?.text || ''}
        meta={pendingPaste?.meta || []}
        mode={pendingPaste?.mode}
        onTextChange={(text) => setPendingPaste((current) => current ? { ...current, text } : current)}
        onRetryPermission={() => void handlePaste()}
        onCancel={() => setPendingPaste(null)}
        onSend={() => {
          if (pendingPaste) sendClipboardText(pendingPaste.text)
          setPendingPaste(null)
        }}
        onEscapeSend={() => {
          if (pendingPaste) sendClipboardText(escapePaste(pendingPaste.text))
          setPendingPaste(null)
        }}
      />
    </div>
  )
}
