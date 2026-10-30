'use client'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'

/**
 * 应用原生 layout string：粘贴 tmux 的 window_layout 串（如
 * `bb62,205x49,0,0[205x24,0,0,0,205x24,0,25,1]`），后端走 select-layout。
 *
 * 与 PromptDialog 的区别必须保留：布局串很长、可能带换行，且 apply 失败时
 * 要把后端 message（400 的校验原因）留在弹窗里让人改，不能弹完就关。
 */
export function LayoutStringDialog({
  open,
  windowName,
  onApply,
  onClose,
}: {
  open: boolean
  windowName: string
  /** 失败要 throw（Error.message 即后端 message），由弹窗就地展示 */
  onApply: (layout: string) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [layout, setLayout] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setLayout('')
    setError(null)
    setBusy(false)
    // 打开后聚焦，方便直接 Cmd/Ctrl+V
    const timer = setTimeout(() => textareaRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [open, windowName])

  if (!open) return null

  const submit = async () => {
    if (busy) return
    const value = layout.trim()
    if (!value) {
      setError(t('window.layoutApplyEmpty'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onApply(value)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('window.layoutApplyFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalPortal
      modal
      onEscape={() => {
        if (!busy) onClose()
      }}
    >
      <div className="fixed inset-0 flex items-center justify-center tmuxgo-scrim p-4" style={{ zIndex: 85 }}>
        <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-lg rounded-apple border p-5">
          <div className="text-lg text-text-1">{t('window.layoutApplyTitle')}</div>
          <div className="mt-1 text-xs text-text-3">{t('window.layoutApplyTarget', { name: windowName })}</div>
          <div className="mt-1 text-caption text-text-3">{t('window.layoutApplyHint')}</div>
          <textarea
            ref={textareaRef}
            data-testid="layout-string-input"
            value={layout}
            onChange={(event) => {
              setLayout(event.target.value)
              if (error) setError(null)
            }}
            placeholder={t('window.layoutApplyPlaceholder')}
            spellCheck={false}
            rows={4}
            className="tmuxgo-control tmuxgo-input mt-3 w-full resize-none rounded-apple px-3 py-2 font-mono text-xs"
          />
          {error && (
            <div data-testid="layout-string-error" role="alert" className="mt-2 text-xs text-danger">
              {error}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
              {t('window.layoutApplyConfirm')}
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
