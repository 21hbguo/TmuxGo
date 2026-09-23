'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from '@/i18n'
import { formatKeyEvent } from '@/hooks/useCustomShortcuts'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { KeyCap } from './KeyCap'
import { Select } from './Select'
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
  'Tab',
  'Esc',
  'Enter',
  'Space',
  'Backspace',
  'Delete',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]

const STEP_TYPE_OPTIONS: ShortcutStep['type'][] = ['keys', 'text', 'wait']

function KeyStepEditor({
  value,
  onChange,
  isMobile,
}: {
  value: string
  onChange: (keys: string) => void
  isMobile?: boolean
}) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  // 录键时占住 ESC 顶层（空操作）：Escape 只退出录制，不连带关掉外层弹窗
  useEscapeClose(() => {}, recording)
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
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
    },
    [recording, onChange],
  )

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
            <KeyCap
              key={m}
              variant="panel"
              size="sm"
              tone={mods[m] ? 'accent' : 'default'}
              onPress={() => setMods((prev) => ({ ...prev, [m]: !prev[m] }))}
            >
              {m}
            </KeyCap>
          ))}
        </div>
        <Select
          value={mainKey}
          onChange={setMainKey}
          options={[{ value: '', label: t('shortcut.selectKey') }, ...MAIN_KEYS.map((k) => ({ value: k, label: k }))]}
          className="w-full rounded-apple px-2 py-1 text-xs"
        />
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
  useEscapeClose(onClose)
  const [label, setLabel] = useState(initialShortcut?.label || '')
  const [repeat, setRepeat] = useState(initialShortcut?.repeat === true)
  const [steps, setSteps] = useState<ShortcutStep[]>(() => {
    if (initialShortcut?.steps?.length) return initialShortcut.steps.map((s) => ({ ...s }))
    if (initialShortcut?.mode === 'text')
      return [{ type: 'text', text: initialShortcut.text || '', appendEnter: initialShortcut.appendEnter === true }]
    return initialShortcut?.keys ? [{ type: 'keys', keys: initialShortcut.keys }] : []
  })

  const updateStep = useCallback((index: number, patch: Partial<ShortcutStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
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

  const stepsValid =
    steps.length > 0 &&
    steps.every((s) =>
      s.type === 'keys'
        ? !!(s.keys || '').trim()
        : s.type === 'text'
          ? !!(s.text || '').trim()
          : typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms > 0 && s.ms <= 60000,
    )
  const canSave = label.trim() && stepsValid
  const STEP_TYPE_LABEL: Record<ShortcutStep['type'], string> = {
    keys: t('shortcut.stepKeys'),
    text: t('shortcut.stepText'),
    wait: t('shortcut.stepWait'),
  }

  const renderStepEditor = (step: ShortcutStep, index: number) => (
    <div key={index} className="rounded-apple border border-[var(--line)] p-2 space-y-2">
      <div className="flex items-center gap-1">
        <Select
          value={step.type}
          onChange={(v) =>
            updateStep(index, {
              type: v as ShortcutStep['type'],
              keys: undefined,
              text: undefined,
              appendEnter: undefined,
              ms: undefined,
            })
          }
          options={STEP_TYPE_OPTIONS.map((opt) => ({ value: opt, label: STEP_TYPE_LABEL[opt] }))}
          className="flex-1 rounded-apple px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={() => moveStep(index, -1)}
          disabled={index === 0}
          aria-label={t('shortcut.moveUp')}
          title={t('shortcut.moveUp')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-3"
        >
          <FiChevronUp aria-hidden="true" size={13} />
        </button>
        <button
          type="button"
          onClick={() => moveStep(index, 1)}
          disabled={index === steps.length - 1}
          aria-label={t('shortcut.moveDown')}
          title={t('shortcut.moveDown')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-3"
        >
          <FiChevronDown aria-hidden="true" size={13} />
        </button>
        <button
          type="button"
          onClick={() => removeStep(index)}
          aria-label={t('shortcut.removeStep')}
          title={t('shortcut.removeStep')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple text-text-3 transition-colors hover:bg-danger/15 hover:text-danger"
        >
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
            <input
              type="checkbox"
              checked={step.appendEnter === true}
              onChange={(e) => updateStep(index, { appendEnter: e.target.checked })}
            />
            {t('shortcut.appendEnter')}
          </label>
        </div>
      )}
      {step.type === 'wait' && (
        <div>
          <label className="text-text-3 text-xs mb-1 block" htmlFor={`shortcut-wait-${index}`}>
            {t('shortcut.waitMs')}
          </label>
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

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-96 rounded-apple border p-4 max-h-[85vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-text-1 text-sm font-medium mb-3">
            {t(initialShortcut ? 'shortcut.edit' : 'shortcut.add')}
          </h3>

          <div className="space-y-3">
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

            <div>
              <label className="text-text-3 text-xs mb-1 block">{t('shortcut.label')}</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
                placeholder={t('shortcut.macroLabelPlaceholder')}
              />
            </div>
            <label className="flex items-center gap-1 text-text-2 text-xs cursor-pointer">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
              {t('shortcut.repeatHold')}
            </label>
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
                onSave({ label: label.trim(), steps, repeat })
              }}
            >
              {t('shortcut.save')}
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
