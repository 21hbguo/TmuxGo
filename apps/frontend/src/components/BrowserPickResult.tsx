'use client'
import { useRef, useState } from 'react'
import { FiCheck, FiCopy, FiX } from 'react-icons/fi'
import { Button } from './Button'
import { useTranslation } from '@/i18n'
import type { BrowserPickElement } from '@/lib/api'

const TEXT_MAX = 80

export function BrowserPickResultCard({ result, onClose }: { result: BrowserPickElement; onClose: () => void }) {
  const { t } = useTranslation()
  // pick 文案 key 由 i18n 包统一合并（本包不改 zh/en）：缺失时 t 原样回退成 key 占位
  const tp = t as (key: string) => string
  const [copied, setCopied] = useState<'selector' | 'ref' | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = async (kind: 'selector' | 'ref', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied(null)
    }
  }
  const text = result.text.length > TEXT_MAX ? `${result.text.slice(0, TEXT_MAX)}…` : result.text

  return (
    <div className="tmuxgo-glass absolute bottom-3 left-1/2 z-20 flex w-[min(28rem,92%)] -translate-x-1/2 flex-col gap-1.5 rounded-apple-lg p-3 text-xs text-text-1">
      <div className="flex items-center justify-between">
        <span className="font-medium">{tp('browser.pickResult')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="text-text-3 hover:text-text-1"
        >
          <FiX size={13} />
        </button>
      </div>
      <code className="min-w-0 overflow-x-auto whitespace-nowrap rounded bg-bg-1 px-2 py-1 text-caption">
        {result.selector}
      </code>
      <div className="text-caption text-text-3">
        {result.tag}
        {result.ref ? ` · ref: ${result.ref}` : ''}
      </div>
      {text && (
        <div className="truncate text-text-2" title={result.text}>
          {text}
        </div>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <Button variant="ghost" size="sm" onClick={() => void copy('selector', result.selector)}>
          {copied === 'selector' ? (
            <FiCheck size={12} className="mr-1 inline text-accent-2" />
          ) : (
            <FiCopy size={12} className="mr-1 inline" />
          )}
          {tp('browser.pickCopySelector')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copy('ref', result.ref)} disabled={!result.ref}>
          {copied === 'ref' ? (
            <FiCheck size={12} className="mr-1 inline text-accent-2" />
          ) : (
            <FiCopy size={12} className="mr-1 inline" />
          )}
          {tp('browser.pickCopyRef')}
        </Button>
        {copied && <span className="text-accent-2">{t('browser.copied')}</span>}
      </div>
    </div>
  )
}
