'use client'

import { useState } from 'react'
import { FiCheck, FiCopy, FiX } from 'react-icons/fi'
import { useElementPickerStore } from '@/stores/useElementPickerStore'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard-text'
import { PICKER_UI_ATTR, type PickedElementInfo } from '@/lib/element-picker'

interface ElementPickerPanelProps {
  info: PickedElementInfo
}

export function ElementPickerPanel({ info }: ElementPickerPanelProps) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const clearSelection = useElementPickerStore((s) => s.clearSelection)
  const [copied, setCopied] = useState(false)

  const copySelector = async () => {
    const result = await writeClipboardText(info.selector)
    if (result.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      pushToast({ type: 'success', message: t('picker.copied'), durationMs: 2000 })
    } else {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
    }
  }

  const rows = [
    ...(info.componentName ? [{ name: t('picker.component'), value: info.componentName }] : []),
    ...info.attributes.map((attr) => ({ name: attr.name, value: attr.value || '""' })),
  ]

  return (
    <div
      {...{ [PICKER_UI_ATTR]: '' }}
      className="tmuxgo-glass tmuxgo-glass-dialog fixed bottom-4 right-4 z-[131] w-[min(26rem,calc(100vw-2rem))] rounded-apple border p-3 text-text-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={info.label}>
          {info.label}
          <span className="ml-2 text-caption text-text-3">
            {Math.round(info.rect.width)}×{Math.round(info.rect.height)}
          </span>
        </span>
        <button
          onClick={clearSelection}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="tmuxgo-toolbar-icon h-7 w-7 shrink-0 text-text-3"
        >
          <FiX aria-hidden="true" size={14} />
        </button>
      </div>

      <div className="mt-2 flex items-start gap-2">
        <code className="tmuxgo-scrollbar max-h-24 min-w-0 flex-1 overflow-y-auto break-all rounded-apple bg-bg-2/60 px-2 py-1.5 font-mono text-caption text-text-1">
          {info.selector}
        </code>
        <button
          onClick={() => void copySelector()}
          aria-label={t('picker.copySelector')}
          title={t('picker.copySelector')}
          className="tmuxgo-toolbar-icon h-7 w-7 shrink-0 text-text-2"
        >
          {copied ? <FiCheck aria-hidden="true" size={14} /> : <FiCopy aria-hidden="true" size={14} />}
        </button>
      </div>

      {rows.length > 0 && (
        <dl className="mt-2 space-y-1">
          {rows.map((row) => (
            <div key={row.name} className="flex gap-2 text-caption">
              <dt className="w-24 shrink-0 truncate text-text-3" title={row.name}>
                {row.name}
              </dt>
              <dd className="min-w-0 truncate text-text-2" title={row.value}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-2 border-t border-[var(--line)] pt-2 text-caption text-text-3">{t('picker.hint')}</div>
    </div>
  )
}
