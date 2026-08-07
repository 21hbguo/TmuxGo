'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '@/i18n'
import { formatKeyEvent } from '@/hooks/useCustomShortcuts'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { KeyCap } from './KeyCap'
import type { CustomShortcut } from '@/types'

interface Props {
  onSave: (data: Omit<CustomShortcut, 'id'>) => void
  onClose: () => void
  isMobile?: boolean
  initialShortcut?: CustomShortcut
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

export function AddShortcutModal({ onSave, onClose, isMobile, initialShortcut }: Props) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(initialShortcut?.label || '')
  const [mode, setMode] = useState<'keys' | 'text'>(initialShortcut?.mode === 'text' ? 'text' : 'keys')
  const [keys, setKeys] = useState(initialShortcut?.keys || '')
  const [text, setText] = useState(initialShortcut?.text || '')
  const [appendEnter, setAppendEnter] = useState(initialShortcut?.appendEnter === true)
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
    if (!recording || mode !== 'keys') return
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
  }, [label, mode, recording])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  const canSave = label.trim() && (mode === 'keys' ? keys.trim() : text.length > 0)

  const toggleMod = (m: string) => setMods((prev) => ({ ...prev, [m]: !prev[m] }))

  return <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim" onClick={onClose}>
      <div className="tmuxgo-glass tmuxgo-glass-dialog w-72 rounded-apple border p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-1 text-sm font-medium mb-3">{t(initialShortcut ? 'shortcut.edit' : 'shortcut.add')}</h3>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-apple bg-bg-2" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'keys'}
              onClick={() => { setRecording(false); setMode('keys') }}
              className={`rounded-apple px-2 py-1.5 text-xs transition-colors ${mode === 'keys' ? 'bg-bg-1 text-text-1 shadow-sm' : 'text-text-3 hover:text-text-2'}`}
            >
              {t('shortcut.modeKeys')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'text'}
              onClick={() => { setRecording(false); setMode('text') }}
              className={`rounded-apple px-2 py-1.5 text-xs transition-colors ${mode === 'text' ? 'bg-bg-1 text-text-1 shadow-sm' : 'text-text-3 hover:text-text-2'}`}
            >
              {t('shortcut.modeText')}
            </button>
          </div>

          {mode === 'text' ? (
            <div>
              <label className="text-text-3 text-xs mb-1 block" htmlFor="shortcut-text">{t('shortcut.text')}</label>
              <textarea
                id="shortcut-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="tmuxgo-control tmuxgo-input w-full min-h-24 resize-y rounded-apple px-2 py-1.5 text-sm"
                placeholder={t('shortcut.textPlaceholder')}
                maxLength={4096}
              />
              <label className="flex items-center gap-2 mt-2 text-text-2 text-xs cursor-pointer">
                <input type="checkbox" checked={appendEnter} onChange={(e) => setAppendEnter(e.target.checked)} />
                {t('shortcut.appendEnter')}
              </label>
            </div>
          ) : isMobile ? (
            <div>
              <label className="text-text-3 text-xs mb-1 block">{t('shortcut.keys')}</label>
              <div className="flex gap-1 mb-2 flex-wrap">
                {MODIFIERS.map((m) => (
                  <KeyCap key={m} variant="panel" size="sm" tone={mods[m] ? 'accent' : 'default'} onPress={() => toggleMod(m)}>
                    {m}
                  </KeyCap>
                ))}
              </div>
              <select
                value={mainKey}
                onChange={(e) => setMainKey(e.target.value)}
                className="tmuxgo-control tmuxgo-select w-full rounded-apple px-2 py-1.5 text-sm"
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
                className={`w-full px-2 py-1.5 rounded-apple text-sm text-left border transition-colors ${
                  recording
                    ? 'bg-accent/10 border-accent text-accent animate-pulse'
                    : 'tmuxgo-control'
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
              className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              placeholder={mode === 'keys' ? keys || 'e.g. Shift+Tab' : t('shortcut.textLabelPlaceholder')}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <Button variant="ghost" size="sm" className="flex-1" onClick={onClose}>
            {t('shortcut.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!canSave}
            onClick={() => {
              if (!canSave) return
              onSave(mode === 'text'
                ? { label: label.trim(), mode, text, appendEnter }
                : { label: label.trim(), mode, keys: keys.trim() })
            }}
          >
            {t('shortcut.save')}
          </Button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
