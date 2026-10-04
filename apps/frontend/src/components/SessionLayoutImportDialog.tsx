'use client'

import { useRef, useState } from 'react'
import { api } from '@/lib/api'
import { parseSessionLayoutDocument } from '@/lib/session-layout'
import type { Session, SessionLayoutApplyMode, SessionLayoutDocument } from '@/types'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalPortal } from './ModalPortal'

interface SessionLayoutImportDialogProps {
  open: boolean
  hostId: string
  sessions: Session[]
  activeSessionId: string
  onApplied: (session: Session, mode: SessionLayoutApplyMode) => void
  onClose: () => void
}

type ImportMode = SessionLayoutApplyMode | 'replace'

function safeErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : ''
  if (!message || /token|secret|password|credential|prompt|pane output|environment|env=/i.test(message)) return fallback
  return message.slice(0, 240)
}

function paneCount(layout: SessionLayoutDocument) {
  return layout.windows.reduce((total, window) => total + window.panes.length, 0)
}

export function SessionLayoutImportDialog({
  open,
  hostId,
  sessions,
  activeSessionId,
  onApplied,
  onClose,
}: SessionLayoutImportDialogProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [layout, setLayout] = useState<SessionLayoutDocument | null>(null)
  const [mode, setMode] = useState<ImportMode>('create')
  const [name, setName] = useState('')
  const [sessionId, setSessionId] = useState(activeSessionId || sessions[0]?.id || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)

  if (!open) return null

  const selectedSession = sessions.find((session) => session.id === sessionId)
  const importName = name.trim() || layout?.name || 'layout'
  const readFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const next = parseSessionLayoutDocument(await file.text())
      setLayout(next)
      setName(next.name)
      setError('')
    } catch (cause) {
      setLayout(null)
      setError(safeErrorMessage(cause, t('layoutImport.invalidFile')))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const applyLayout = async () => {
    if (!layout || busy) return
    if (mode === 'append' && !selectedSession) {
      setError(t('layoutImport.selectSession'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.sessions.applyLayout(hostId, {
        layout,
        mode: mode === 'append' ? 'append' : 'create',
        name: mode === 'append' ? undefined : mode === 'replace' ? selectedSession?.name : importName,
        sessionId: mode === 'append' ? sessionId : mode === 'replace' ? selectedSession?.id : undefined,
        replace: mode === 'replace',
      })
      setConfirmReplace(false)
      onApplied(result.session as Session, result.mode)
    } catch (cause) {
      setError(safeErrorMessage(cause, t('layoutImport.applyFailed')))
    } finally {
      setBusy(false)
    }
  }
  const handleApply = () => {
    if (mode === 'replace') setConfirmReplace(true)
    else void applyLayout()
  }

  return (
    <ModalPortal modal onEscape={busy ? undefined : onClose}>
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center tmuxgo-scrim p-4"
        onClick={busy ? undefined : onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('layoutImport.title')}
          className="tmuxgo-glass tmuxgo-glass-dialog flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-apple border p-5"
          onClick={(event) => event.stopPropagation()}
        >
          <div>
            <h2 className="text-lg font-medium text-text-1">{t('layoutImport.title')}</h2>
            <p className="mt-1 text-sm text-text-3">{t('layoutImport.description')}</p>
          </div>
          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              {t('layoutImport.chooseFile')}
            </Button>
            {layout && (
              <div className="rounded-apple border border-[var(--line)] bg-bg-2 p-3 text-sm">
                <div className="font-medium text-text-1">{layout.name}</div>
                <div className="mt-1 text-text-3">
                  {t('layoutImport.previewSummary', { windows: layout.windows.length, panes: paneCount(layout) })}
                </div>
                <div className="mt-3 space-y-1 text-xs text-text-2">
                  {layout.windows.map((window) => (
                    <div key={window.name} className="flex justify-between gap-3">
                      <span className="truncate">{window.name}</span>
                      <span className="shrink-0 text-text-3">
                        {t('layoutImport.paneCount', { count: window.panes.length })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {layout && (
              <div className="space-y-3">
                <label className="block text-sm text-text-2">
                  {t('layoutImport.mode')}
                  <select
                    aria-label={t('layoutImport.mode')}
                    value={mode}
                    onChange={(event) => setMode(event.target.value as ImportMode)}
                    disabled={busy}
                    className="tmuxgo-control tmuxgo-input mt-1 w-full rounded-apple px-3 py-2"
                  >
                    <option value="create">{t('layoutImport.modeCreate')}</option>
                    <option value="append">{t('layoutImport.modeAppend')}</option>
                    <option value="replace">{t('layoutImport.modeReplace')}</option>
                  </select>
                </label>
                {mode !== 'create' && (
                  <label className="block text-sm text-text-2">
                    {t('layoutImport.targetSession')}
                    <select
                      aria-label={t('layoutImport.targetSession')}
                      value={sessionId}
                      onChange={(event) => setSessionId(event.target.value)}
                      disabled={busy || !sessions.length}
                      className="tmuxgo-control tmuxgo-input mt-1 w-full rounded-apple px-3 py-2"
                    >
                      <option value="">{t('layoutImport.selectSession')}</option>
                      {sessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {session.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {mode !== 'append' && (
                  <label className="block text-sm text-text-2">
                    {t('layoutImport.sessionName')}
                    <input
                      aria-label={t('layoutImport.sessionName')}
                      value={mode === 'replace' ? selectedSession?.name || '' : name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={busy || mode === 'replace'}
                      className="tmuxgo-control tmuxgo-input mt-1 w-full rounded-apple px-3 py-2"
                    />
                  </label>
                )}
                <div className="text-xs text-text-3">
                  {mode === 'replace' ? t('layoutImport.replaceWarning') : t('layoutImport.noOverwriteHint')}
                </div>
              </div>
            )}
            {error && (
              <div role="alert" className="break-words text-sm text-danger">
                {error}
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {t('layoutImport.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleApply}
              disabled={!layout || busy || (mode !== 'create' && !selectedSession)}
            >
              {busy ? t('layoutImport.applying') : t('layoutImport.apply')}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmReplace}
        title={t('layoutImport.replaceTitle')}
        message={t('layoutImport.replaceConfirm', { name: selectedSession?.name || importName })}
        confirmLabel={t('layoutImport.replaceAction')}
        cancelLabel={t('layoutImport.cancel')}
        tone="danger"
        onConfirm={applyLayout}
        onCancel={() => setConfirmReplace(false)}
      />
    </ModalPortal>
  )
}
