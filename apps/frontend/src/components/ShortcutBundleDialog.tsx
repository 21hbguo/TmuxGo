'use client'

import { useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard-text'
import {
  buildShortcutBundle,
  parseShortcutBundle,
  serializeShortcutBundle,
  shortcutIdentity,
  type ShortcutBundleEntry,
  type ShortcutBundleIssue,
} from '@/lib/shortcut-bundle'
import type { CustomShortcut } from '@/types'
import { Button } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalPortal } from './ModalPortal'

export type ShortcutImportMode = 'merge' | 'replace'

interface ShortcutBundleDialogProps {
  open: boolean
  shortcuts: CustomShortcut[]
  onImport: (entries: ShortcutBundleEntry[], mode: ShortcutImportMode) => { added: number; skipped: number }
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
  onClose: () => void
}

type Tab = 'export' | 'import'

const ISSUE_KEYS = {
  entry: 'shortcut.bundleIssueEntry',
  label: 'shortcut.bundleIssueLabel',
  steps: 'shortcut.bundleIssueSteps',
  'step-keys': 'shortcut.bundleIssueKeys',
  'step-text': 'shortcut.bundleIssueText',
  'step-wait': 'shortcut.bundleIssueWait',
} as const satisfies Record<ShortcutBundleIssue['code'], string>

export function ShortcutBundleDialog({ open, shortcuts, onImport, onNotify, onClose }: ShortcutBundleDialogProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<Tab>('export')
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ShortcutImportMode>('merge')
  const [fileName, setFileName] = useState('')
  // 覆盖会丢掉现有一整批快捷键，落地前必须再确认一次
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false)

  const exportText = useMemo(() => serializeShortcutBundle(buildShortcutBundle(shortcuts)), [shortcuts])
  const parsed = useMemo(() => {
    if (!text.trim()) return null
    try {
      return parseShortcutBundle(text)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid JSON' }
    }
  }, [text])
  const parsedShortcuts = useMemo(() => (parsed && !('error' in parsed) ? parsed.shortcuts : []), [parsed])
  const issues = useMemo(() => (parsed && !('error' in parsed) ? parsed.issues : []), [parsed])
  const duplicates = useMemo(() => {
    if (mode !== 'merge' || parsedShortcuts.length === 0) return 0
    const seen = new Set(shortcuts.map(shortcutIdentity))
    return parsedShortcuts.filter((item) => seen.has(shortcutIdentity(item))).length
  }, [mode, parsedShortcuts, shortcuts])
  const canImport = parsedShortcuts.length > 0 && !(parsed && 'error' in parsed)

  if (!open) return null

  const readFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setText(await file.text())
      setFileName(file.name)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const copy = async () => {
    const written = await writeClipboardText(exportText)
    if (written.copied) onNotify(t('shortcut.bundleCopied'), 'success')
    else onNotify(t('shortcut.bundleCopyFailed'), 'error')
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `tmuxgo-shortcuts-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    // 延后回收：click 同步触发下载，立即 revoke 会让部分浏览器拿到失效 URL
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    onNotify(t('shortcut.bundleDownloaded'), 'success')
  }
  const runImport = () => {
    const result = onImport(parsedShortcuts, mode)
    onNotify(t('shortcut.bundleImported', { count: result.added, skipped: result.skipped }), 'success')
    setConfirmReplaceOpen(false)
    setText('')
    setFileName('')
    onClose()
  }
  const apply = () => {
    if (!canImport) return
    // 现有为空时覆盖等价于新增，不必多问一次
    if (mode === 'replace' && shortcuts.length > 0) {
      setConfirmReplaceOpen(true)
      return
    }
    runImport()
  }

  const issueText = (issue: ShortcutBundleIssue) =>
    t(ISSUE_KEYS[issue.code], { index: issue.index + 1, keys: issue.keys || '' })

  return (
    <ModalPortal modal onEscape={onClose}>
      <div className="fixed inset-0 z-[110] flex items-center justify-center tmuxgo-scrim p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('shortcut.bundleTitle')}
          className="tmuxgo-glass tmuxgo-glass-dialog flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-apple border p-5"
          onClick={(event) => event.stopPropagation()}
        >
          <div>
            <h2 className="text-lg font-medium text-text-1">{t('shortcut.bundleTitle')}</h2>
            <p className="mt-1 text-sm text-text-3">{t('shortcut.bundleFormatHint')}</p>
          </div>

          <div className="mt-3 flex gap-1">
            <Button
              size="sm"
              variant={tab === 'export' ? 'primary' : 'ghost'}
              onClick={() => setTab('export')}
              aria-pressed={tab === 'export'}
            >
              {t('shortcut.bundleExport')}
            </Button>
            <Button
              size="sm"
              variant={tab === 'import' ? 'primary' : 'ghost'}
              onClick={() => setTab('import')}
              aria-pressed={tab === 'import'}
            >
              {t('shortcut.bundleImport')}
            </Button>
          </div>

          {tab === 'export' ? (
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
              <p className="text-xs text-text-3">{t('shortcut.bundleExportHint', { count: shortcuts.length })}</p>
              <textarea
                readOnly
                value={exportText}
                aria-label={t('shortcut.bundleExport')}
                className="tmuxgo-control tmuxgo-input min-h-[220px] flex-1 resize-none rounded-apple px-2 py-1 font-mono text-xs"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => void copy()}>
                  {t('shortcut.bundleCopy')}
                </Button>
                <Button size="sm" variant="primary" onClick={download}>
                  {t('shortcut.bundleDownload')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              <p className="text-xs text-text-3">{t('shortcut.bundleImportHint')}</p>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(event) => void readFile(event.target.files?.[0])}
                />
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  {t('shortcut.bundleChooseFile')}
                </Button>
                {fileName && <span className="truncate text-xs text-text-3">{fileName}</span>}
              </div>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('shortcut.bundlePastePlaceholder')}
                aria-label={t('shortcut.bundleImport')}
                className="tmuxgo-control tmuxgo-input min-h-[160px] resize-y rounded-apple px-2 py-1 font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-3">
                <label className="flex items-center gap-1">
                  <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} />
                  {t('shortcut.bundleModeMerge')}
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                  {t('shortcut.bundleModeReplace')}
                </label>
              </div>
              {parsed && 'error' in parsed && <p className="text-xs text-danger">{parsed.error}</p>}
              {parsedShortcuts.length > 0 && (
                <p className="text-xs text-text-2">
                  {t('shortcut.bundlePreview', { count: parsedShortcuts.length })}
                  {duplicates > 0 ? ` · ${t('shortcut.bundleDuplicates', { count: duplicates })}` : ''}
                </p>
              )}
              {issues.length > 0 && (
                <div className="rounded-apple border border-danger/40 bg-danger/5 px-2 py-1">
                  <div className="text-xs text-danger">{t('shortcut.bundleIssueCount', { count: issues.length })}</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-3">
                    {issues.slice(0, 8).map((issue) => (
                      <li key={`${issue.index}-${issue.code}`}>{issueText(issue)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" variant="primary" disabled={!canImport} onClick={apply}>
                  {t('shortcut.bundleApply')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmReplaceOpen}
        title={t('shortcut.bundleReplaceTitle')}
        message={t('shortcut.bundleReplaceMessage', { count: shortcuts.length, importCount: parsedShortcuts.length })}
        confirmLabel={t('shortcut.bundleReplaceAction')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={runImport}
        onCancel={() => setConfirmReplaceOpen(false)}
      />
    </ModalPortal>
  )
}
