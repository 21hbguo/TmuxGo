'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from '@/i18n'
import { formatKeyEvent } from '@/hooks/useCustomShortcuts'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { KeyCap } from './KeyCap'
import { FiChevronUp, FiChevronDown, FiTrash2, FiPlus } from 'react-icons/fi'
import type { CustomShortcut, ShortcutStep } from '@/types'

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

const STEP_TYPE_OPTIONS: ShortcutStep['type'][] = ['keys', 'text', 'wait']

function KeyStepEditor({ value, onChange, isMobile }: { value: string; onChange: (keys: string) => void; isMobile?: boolean }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [mods, setMods] = useState<Record<string, boolean>>({})
  const [mainKey, setMainKey] = useState('')
  const onChangeRef = useRef(onChange)
  const lastSentRef = useRef('')

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const pickerKeys = useMemo(() => {
    const parts: string[] = []
    for (const m of MODIFIERS) {
      if (mods[m]) parts.push(m)
    }
    if (mainKey) parts.push(mainKey)
    return parts.join('+')
  }, [mods, mainKey])

  useEffect(() => {
    if (!isMobile || value === lastSentRef.current) return
    const parts = value.split('+')
    const nextMods: Record<string, boolean> = {}
    let main = ''
    for (const p of parts) {
      if ((MODIFIERS as readonly string[]).includes(p)) nextMods[p] = true
      else main = p
    }
    setMods(nextMods)
    setMainKey(main)
  }, [isMobile, value])

  useEffect(() => {
    if (isMobile && pickerKeys && pickerKeys !== lastSentRef.current) {
      lastSentRef.current = pickerKeys
      onChangeRef.current(pickerKeys)
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
      onChange(combo)
      setRecording(false)
    }
  }, [recording, onChange])

  useEffect(() => {
    if (!isMobile && recording) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isMobile, recording, handleKeyDown])

  if (isMobile) {
    return (
      <div className="space-y-1">
        <div className="flex gap-1 flex-wrap">
          {MODIFIERS.map((m) => (
            <KeyCap key={m} variant="panel" size="sm" tone={mods[m] ? 'accent' : 'default'} onPress={() => setMods((prev) => ({ ...prev, [m]: !prev[m] }))}>
              {m}
            </KeyCap>
          ))}
        </div>
        <select
          value={mainKey}
          onChange={(e) => setMainKey(e.target.value)}
          className="tmuxgo-control tmuxgo-select w-full rounded-apple px-2 py-1 text-xs"
        >
          <option value="">{t('shortcut.selectKey')}</option>
          {MAIN_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        {value && <div className="text-accent text-xs">{value}</div>}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      className={`w-full px-2 py-1 rounded-apple text-xs text-left border transition-colors ${recording ? 'bg-accent/10 border-accent text-accent animate-pulse' : 'tmuxgo-control'}`}
    >
      {recording ? t('shortcut.recording') : value || t('shortcut.pressKeys')}
    </button>
  )
}

export function AddShortcutModal({ onSave, onClose, isMobile, initialShortcut }: Props) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(initialShortcut?.label || '')
  const [mode, setMode] = useState<'keys' | 'text' | 'macro'>(initialShortcut?.steps?.length ? 'macro' : initialShortcut?.mode === 'text' ? 'text' : 'keys')
  const [keys, setKeys] = useState(initialShortcut?.keys || '')
  const [text, setText] = useState(initialShortcut?.text || '')
  const [appendEnter, setAppendEnter] = useState(initialShortcut?.appendEnter === true)
  const [steps, setSteps] = useState<ShortcutStep[]>(() => {
    if (initialShortcut?.steps?.length) return initialShortcut.steps.map((s) => ({ ...s }))
    if (initialShortcut?.mode === 'text') return [{ type: 'text', text: initialShortcut.text || '', appendEnter: initialShortcut.appendEnter === true }]
    return initialShortcut?.keys ? [{ type: 'keys', keys: initialShortcut.keys }] : []
  })
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

  const updateStep = useCallback((index: number, patch: Partial<ShortcutStep>) => {
    setSteps((prev) => prev.map((s, i) => i === index ? { ...s, ...patch } : s))
  }, [])

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, { type: 'text', text: '', appendEnter: false }])
  }, [])

  const removeStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const moveStep = useCallback((index: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

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

  const stepsValid = steps.length > 0 && steps.every((s) => s.type === 'keys' ? !!(s.keys || '').trim() : s.type === 'text' ? !!(s.text || '').trim() : typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms > 0 && s.ms <= 60000)
  const canSave = label.trim() && (mode === 'keys' ? keys.trim() : mode === 'text' ? text.length > 0 : stepsValid)
  const toggleMod = (m: string) => setMods((prev) => ({ ...prev, [m]: !prev[m] }))
  const STEP_TYPE_LABEL: Record<ShortcutStep['type'], string> = { keys: t('shortcut.stepKeys'), text: t('shortcut.stepText'), wait: t('shortcut.stepWait') }

  const renderStepEditor = (step: ShortcutStep, index: number) => (
    <div key={index} className="rounded-apple border border-[var(--line)] p-2 space-y-2">
      <div className="flex items-center gap-1">
        <select
          value={step.type}
          onChange={(e) => updateStep(index, { type: e.target.value as ShortcutStep['type'], keys: undefined, text: undefined, appendEnter: undefined, ms: undefined })}
          className="tmuxgo-control tmuxgo-select flex-1 rounded-apple px-2 py-1 text-xs"
        >
          {STEP_TYPE_OPTIONS.map((opt) => <option key={opt} value={opt}>{STEP_TYPE_LABEL[opt]}</option>)}
        </select>
        <button type="button" onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label={t('shortcut.moveUp')} title={t('shortcut.moveUp')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-3">
          <FiChevronUp aria-hidden="true" size={13} />
        </button>
        <button type="button" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} aria-label={t('shortcut.moveDown')} title={t('shortcut.moveDown')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-3">
          <FiChevronDown aria-hidden="true" size={13} />
        </button>
        <button type="button" onClick={() => removeStep(index)} aria-label={t('shortcut.removeStep')} title={t('shortcut.removeStep')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-danger/15 hover:text-danger">
          <FiTrash2 aria-hidden="true" size={13} />
        </button>
      </div>
      {step.type === 'keys' && (
        <KeyStepEditor value={step.keys || ''} onChange={(keys) => updateStep(index, { keys })} isMobile={isMobile} />
      )}
      {step.type === 'text' && (
        <div className="space-y-1">
          <textarea
            value={step.text || ''}
            onChange={(e) => updateStep(index, { text: e.target.value })}
            className="tmuxgo-control tmuxgo-input w-full min-h-16 resize-y rounded-apple px-2 py-1 text-xs"
            placeholder={t('shortcut.textPlaceholder')}
            maxLength={4096}
          />
          <label className="flex items-center gap-1 text-text-2 text-xs cursor-pointer">
            <input type="checkbox" checked={step.appendEnter === true} onChange={(e) => updateStep(index, { appendEnter: e.target.checked })} />
            {t('shortcut.appendEnter')}
          </label>
        </div>
      )}
      {step.type === 'wait' && (
        <div>
          <label className="text-text-3 text-xs mb-1 block" htmlFor={`shortcut-wait-${index}`}>{t('shortcut.waitMs')}</label>
          <input
            id={`shortcut-wait-${index}`}
            type="number"
            min={1}
            max={60000}
            value={step.ms || ''}
            onChange={(e) => updateStep(index, { ms: e.target.value === '' ? undefined : Number(e.target.value) })}
            className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1 text-xs"
            placeholder={t('shortcut.waitPlaceholder')}
          />
        </div>
      )}
    </div>
  )

  return <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim" onClick={onClose}>
      <div className={`tmuxgo-glass tmuxgo-glass-dialog ${mode === 'macro' ? 'w-96' : 'w-72'} rounded-apple border p-4 max-h-[85vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-1 text-sm font-medium mb-3">{t(initialShortcut ? 'shortcut.edit' : 'shortcut.add')}</h3>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1 p-1 rounded-apple bg-bg-2" role="tablist">
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
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'macro'}
              onClick={() => { setRecording(false); setMode('macro') }}
              className={`rounded-apple px-2 py-1.5 text-xs transition-colors ${mode === 'macro' ? 'bg-bg-1 text-text-1 shadow-sm' : 'text-text-3 hover:text-text-2'}`}
            >
              {t('shortcut.modeMacro')}
            </button>
          </div>

          {mode === 'keys' ? (
            isMobile ? (
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
            )
          ) : mode === 'text' ? (
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
          ) : (
            <div>
              <div className="space-y-2">
                {steps.map((step, index) => renderStepEditor(step, index))}
                {steps.length === 0 && <div className="text-text-3 text-xs">{t('shortcut.noSteps')}</div>}
              </div>
              <button
                type="button"
                onClick={addStep}
                className="mt-2 flex w-full items-center justify-center gap-1 px-2 py-1.5 rounded-apple text-xs transition-colors border border-dashed border-[var(--line)] text-text-3 hover:text-text-2 hover:border-accent/50"
              >
                <FiPlus aria-hidden="true" size={13} />
                {t('shortcut.addStep')}
              </button>
            </div>
          )}

          <div>
            <label className="text-text-3 text-xs mb-1 block">{t('shortcut.label')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              placeholder={mode === 'keys' ? keys || 'e.g. Shift+Tab' : mode === 'text' ? t('shortcut.textLabelPlaceholder') : t('shortcut.macroLabelPlaceholder')}
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
              if (mode === 'macro') {
                onSave({ label: label.trim(), steps })
              } else if (mode === 'text') {
                onSave({ label: label.trim(), steps: [{ type: 'text', text, appendEnter }] })
              } else {
                onSave({ label: label.trim(), steps: [{ type: 'keys', keys: keys.trim() }] })
              }
            }}
          >
            {t('shortcut.save')}
          </Button>
        </div>
      </div>
    </div>
  </ModalPortal>
}
