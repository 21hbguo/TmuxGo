'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '@/i18n'
import { formatKeyEvent } from '@/hooks/useCustomShortcuts'

interface Props {
  onSave: (data: { label: string; keys: string }) => void
  onClose: () => void
  isMobile?: boolean
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

const MAIN_KEYS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  'Tab', 'Esc', 'Enter', 'Space', 'Backspace', 'Delete',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]

export function AddShortcutModal({ onSave, onClose, isMobile }: Props) {
  const { t } = useTranslation()
  const [label, setLabel] = useState('')
  const [keys, setKeys] = useState('')
  const [recording, setRecording] = useState(false)
  const [mods, setMods] = useState<Record<string, boolean>>({})
  const [mainKey, setMainKey] = useState('')

  const pickerKeys = useMemo(() => {
    const parts: string[] = []
    for (const m of MODIFIERS) {
      if (mods[m]) parts.push(m)
    }
    if (mainKey) parts.push(mainKey)
    return parts.join('+')
  }, [mods, mainKey])

  useEffect(() => {
    if (isMobile && pickerKeys) {
      setKeys(pickerKeys)
      if (!label) setLabel(pickerKeys)
    }
  }, [pickerKeys, isMobile])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setRecording(false)
      return
    }

    const combo = formatKeyEvent(e)
    if (combo && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      setKeys(combo)
      if (!label) setLabel(combo)
      setRecording(false)
    }
  }, [recording, label])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  const canSave = label.trim() && keys.trim()

  const toggleMod = (m: string) => setMods((prev) => ({ ...prev, [m]: !prev[m] }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg shadow-xl w-72 p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-1 text-sm font-medium mb-3">{t('shortcut.add')}</h3>

        <div className="space-y-3">
          {isMobile ? (
            <div>
              <label className="text-text-3 text-xs mb-1 block">{t('shortcut.keys')}</label>
              <div className="flex gap-1 mb-2 flex-wrap">
                {MODIFIERS.map((m) => (
                  <button key={m} onClick={() => toggleMod(m)}
                    className={`px-2 py-1 rounded text-xs border transition-colors ${mods[m] ? 'bg-accent/20 border-accent text-accent' : 'bg-bg-2 border-[var(--line)] text-text-3'}`}>
                    {m}
                  </button>
                ))}
              </div>
              <select
                value={mainKey}
                onChange={(e) => setMainKey(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-bg-2 text-text-1 text-sm border border-[var(--line)] outline-none focus:border-accent"
              >
                <option value="">{t('shortcut.selectKey')}</option>
                {MAIN_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              {keys && <div className="text-accent text-xs mt-1">{keys}</div>}
            </div>
          ) : (
            <div>
              <label className="text-text-3 text-xs mb-1 block">{t('shortcut.keys')}</label>
              <button
                onClick={() => setRecording(true)}
                className={`w-full px-2 py-1.5 rounded text-sm text-left border transition-colors ${
                  recording
                    ? 'bg-accent/20 border-accent text-accent animate-pulse'
                    : 'bg-bg-2 border-[var(--line)] text-text-1 hover:border-accent/50'
                }`}
              >
                {recording ? t('shortcut.recording') : keys || t('shortcut.pressKeys')}
              </button>
            </div>
          )}

          <div>
            <label className="text-text-3 text-xs mb-1 block">{t('shortcut.label')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-bg-2 text-text-1 text-sm border border-[var(--line)] outline-none focus:border-accent"
              placeholder={keys || 'e.g. Shift+Tab'}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-1.5 rounded text-xs bg-bg-2 text-text-2 hover:bg-bg-1">
            {t('shortcut.cancel')}
          </button>
          <button
            onClick={() => canSave && onSave({ label: label.trim(), keys: keys.trim() })}
            disabled={!canSave}
            className={`flex-1 px-3 py-1.5 rounded text-xs ${canSave ? 'bg-accent text-white hover:bg-accent/90' : 'bg-bg-2/60 text-text-3 cursor-not-allowed'}`}
          >
            {t('shortcut.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
