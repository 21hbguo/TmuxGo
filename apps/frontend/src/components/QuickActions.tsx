'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useCustomShortcuts, keysToEscape } from '@/hooks/useCustomShortcuts'
import { AddShortcutModal } from './AddShortcutModal'
import { api } from '@/lib/api'

const btn = 'px-2 py-1.5 rounded text-xs transition-colors bg-bg-2 text-text-2 hover:bg-bg-1 active:bg-bg-0'

export function QuickActions() {
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const [pendingDirection, setPendingDirection] = useState<'horizontal' | 'vertical' | null>(null)
  const sessionName = activeSessionId?.replace('session-', '') || ''
  const activeWindow = useMemo(() => windowsData.find((w: any) => w.active) || windowsData[0] || null, [windowsData])
  const canSplit = !!sessionName && !!activeWindow && !pendingDirection
  const { send } = useWebSocket()
  const { shortcuts, addShortcut, removeShortcut } = useCustomShortcuts()
  const [showModal, setShowModal] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const sendKey = (data: string) => send({ type: 'input', data })

  const handleSplit = async (direction: 'horizontal' | 'vertical') => {
    if (!sessionName || !activeWindow || pendingDirection) return
    setPendingDirection(direction)
    try {
      await api.panes.create(`${sessionName}:${activeWindow.index}`, direction)
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
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (text) sendKey(text)
      } else {
        const ta = document.createElement('textarea')
        ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta)
        ta.focus()
        document.execCommand('paste')
        const text = ta.value
        document.body.removeChild(ta)
        if (text) sendKey(text)
      }
    } catch {}
  }

  const handleKillPane = async () => {
    if (!sessionName) return
    if (!window.confirm(t('quick.killConfirm'))) return
    try {
      await api.panes.kill(sessionName)
    } catch {}
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
        <button onClick={() => api.panes.zoom(sessionName)} disabled={!sessionName}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${sessionName ? 'bg-bg-2 text-text-2 hover:bg-bg-1' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
          {t('quick.zoom')}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <button onClick={handleCopy} className={btn}>{t('quick.copy')}</button>
        <button onClick={handlePaste} className={btn}>{t('quick.paste')}</button>
        <button onClick={handleKillPane} disabled={!sessionName}
          className={`px-2 py-1.5 rounded text-xs transition-colors ${sessionName ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}>
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
    </div>
  )
}
