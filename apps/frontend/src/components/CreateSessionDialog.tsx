'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { ModalPortal } from './ModalPortal'
import { FilePanel, type FilePanelPickerTarget } from './FilePanel'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useTranslation } from '@/i18n'
import type { SessionTemplate } from '@/types'

export interface CreateSessionDialogResult {
  name: string
  cwd?: string
  workspace?: FilePanelPickerTarget
}
interface CreateSessionDialogProps {
  open: boolean
  template: SessionTemplate | null
  defaultName: string
  onCreate: (result: CreateSessionDialogResult) => Promise<void> | void
  onClose: () => void
}
export function CreateSessionDialog({ open, template, defaultName, onCreate, onClose }: CreateSessionDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(defaultName)
  const [workspace, setWorkspace] = useState<FilePanelPickerTarget | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const isMobile = isMobileDevice()
  useEffect(() => {
    if (open) {
      setName(defaultName)
      setWorkspace(null)
      setPickerOpen(false)
      setSubmitting(false)
      const timer = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [open, defaultName])
  if (!open || !template) return null
  const handlePick = (target: FilePanelPickerTarget) => {
    setWorkspace(target)
    setPickerOpen(false)
    if (isMobile) setTimeout(() => inputRef.current?.focus(), 50)
  }
  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate({ name: trimmed, cwd: workspace?.absolutePath, workspace: workspace || undefined })
    } finally {
      setSubmitting(false)
    }
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !pickerOpen) {
      e.preventDefault()
      void handleCreate()
    }
    if (e.key === 'Escape' && !pickerOpen) onClose()
  }
  const workspaceLabel = workspace ? workspace.absolutePath : ''
  const containerClass = isMobile
    ? 'fixed inset-0 z-[80] flex flex-col bg-bg-0'
    : 'fixed inset-0 z-[80] flex items-center justify-center tmuxgo-scrim p-4'
  const dialogClass = isMobile
    ? 'flex h-full w-full flex-col overflow-hidden'
    : 'tmuxgo-glass tmuxgo-glass-dialog flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-apple border'
  const bodyClass = isMobile
    ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
    : 'flex min-h-0 flex-1 flex-col overflow-hidden'
  return (
    <ModalPortal>
      <div className={containerClass} onClick={isMobile ? undefined : onClose}>
        <div className={dialogClass} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-3">
            <div className="flex items-center gap-2">
              {isMobile && <Button variant="ghost" size="icon-sm" aria-label={t('common.cancel')} onClick={onClose}>‹</Button>}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-1">{t('session.createTitle')}</div>
                <div className="truncate text-caption text-text-3">{template.name}</div>
              </div>
              {!isMobile && <Button variant="ghost" size="icon-sm" aria-label={t('common.cancel')} onClick={onClose}>×</Button>}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('drawer.sessionName')}
                className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-xs text-text-3" title={workspaceLabel || t('session.noWorkspace')}>
                <span className="text-text-2">{t('session.workspace')}: </span>
                <span className={workspace ? 'font-mono text-text-1' : 'text-text-3'}>{workspaceLabel || t('session.noWorkspace')}</span>
              </div>
              {workspace ? (
                <Chip tone="default" onClick={() => setPickerOpen(true)}>{t('session.changeWorkspace')}</Chip>
              ) : (
                <Chip tone="accent" onClick={() => setPickerOpen((prev) => !prev)}>{pickerOpen ? t('session.hidePicker') : t('session.selectWorkspace')}</Chip>
              )}
            </div>
          </div>
          {pickerOpen && (
            <div className={bodyClass}>
              <FilePanel mode="picker" onPick={handlePick} onClose={() => setPickerOpen(false)} />
            </div>
          )}
          <div className="shrink-0 border-t border-[var(--line)] px-4 py-3" style={{ paddingBottom: isMobile ? 'max(env(safe-area-inset-bottom,0px),0.75rem)' : undefined }}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-caption text-text-3">{workspace ? t('session.workspaceHintSelected') : t('session.workspaceHintNone')}</div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
                <Button variant="primary" size="sm" onClick={() => void handleCreate()} disabled={!name.trim() || submitting}>{t('session.createAction')}</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
