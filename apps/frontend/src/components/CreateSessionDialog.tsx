'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { ModalPortal } from './ModalPortal'
import { FilePanel, type FilePanelPickerTarget } from './FilePanel'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useCreateWorkspace } from '@/hooks/useWorkspaces'
import { usePrompt } from '@/hooks/usePrompt'
import { useTranslation } from '@/i18n'
import type { SessionTemplate, WorkspaceEntry } from '@/types'

export interface CreateSessionDialogWorkspace extends FilePanelPickerTarget {
  workspaceId?: string
  workspaceName?: string
}
export interface CreateSessionDialogResult {
  name: string
  cwd?: string
  workspace?: CreateSessionDialogWorkspace
}
interface CreateSessionDialogProps {
  open: boolean
  template: SessionTemplate | null
  defaultName: string
  hostId: string
  workspaces: WorkspaceEntry[]
  initialWorkspace?: WorkspaceEntry | null
  onCreate: (result: CreateSessionDialogResult) => Promise<void> | void
  onClose: () => void
}
function toDialogWorkspace(workspace: WorkspaceEntry): CreateSessionDialogWorkspace {
  return { rootId: workspace.rootId, rootPath: workspace.rootPath, rootLabel: workspace.rootLabel, relativePath: workspace.relativePath, absolutePath: workspace.path, workspaceId: workspace.id, workspaceName: workspace.name }
}
export function CreateSessionDialog({ open, template, defaultName, hostId, workspaces, initialWorkspace, onCreate, onClose }: CreateSessionDialogProps) {
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const createWorkspace = useCreateWorkspace()
  const [name, setName] = useState(defaultName)
  const [workspace, setWorkspace] = useState<CreateSessionDialogWorkspace | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const isMobile = isMobileDevice()
  const hostWorkspaces = workspaces.filter((item) => item.hostId === hostId)
  useEffect(() => {
    if (open) {
      setName(defaultName)
      setWorkspace(initialWorkspace ? toDialogWorkspace(initialWorkspace) : null)
      setPickerOpen(false)
      setCreatingWorkspace(false)
      setSubmitting(false)
      const timer = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [open, defaultName, initialWorkspace])
  if (!open || !template) return null
  const handleSelectWorkspace = (workspaceId: string) => {
    if (!workspaceId) return setWorkspace(null)
    if (workspaceId === 'new') {
      setCreatingWorkspace(true)
      setPickerOpen(true)
      return
    }
    const found = hostWorkspaces.find((item) => item.id === workspaceId)
    if (found) setWorkspace(toDialogWorkspace(found))
  }
  const handlePick = async (target: FilePanelPickerTarget) => {
    setPickerOpen(false)
    const matched = hostWorkspaces.find((item) => item.path === target.absolutePath)
    if (matched) return setWorkspace(toDialogWorkspace(matched))
    if (creatingWorkspace) {
      const wsName = await prompt(t('workspace.createTitle'), '')
      if (wsName && wsName.trim()) {
        try {
          const created = await createWorkspace.mutateAsync({ name: wsName.trim(), hostId, path: target.absolutePath, rootId: target.rootId, rootPath: target.rootPath, rootLabel: target.rootLabel, relativePath: target.relativePath })
          return setWorkspace(toDialogWorkspace(created.workspace))
        } catch {}
      }
    }
    setCreatingWorkspace(false)
    setWorkspace({ ...target })
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
              <select
                value={workspace?.workspaceId || ''}
                onChange={(e) => handleSelectWorkspace(e.target.value)}
                className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-2 py-2 text-xs"
              >
                <option value="">{t('session.noWorkspace')}</option>
                {hostWorkspaces.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.path}</option>
                ))}
                <option value="new">{t('workspace.createNew')}</option>
              </select>
              <Chip tone={workspace ? 'default' : 'accent'} onClick={() => { setCreatingWorkspace(false); setPickerOpen((prev) => !prev) }}>{pickerOpen ? t('session.hidePicker') : t('session.browseDirectory')}</Chip>
            </div>
            {workspace && (
              <div className="mt-1 flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-xs text-text-3" title={workspace.absolutePath}>
                  <span className="text-text-2">{t('session.workspace')}: </span>
                  <span className="font-mono text-text-1">{workspace.workspaceName || workspace.absolutePath}</span>
                  {workspace.workspaceName && <span className="ml-2 font-mono text-text-3">{workspace.absolutePath}</span>}
                </div>
                <Chip tone="default" onClick={() => setWorkspace(null)}>{t('workspace.clear')}</Chip>
              </div>
            )}
          </div>
          {pickerOpen && (
            <div className={bodyClass}>
              <FilePanel mode="picker" onPick={(target) => void handlePick(target)} onClose={() => setPickerOpen(false)} />
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
      {PromptElement}
    </ModalPortal>
  )
}