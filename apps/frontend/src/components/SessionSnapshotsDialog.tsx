'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { SessionSnapshotDoc, SessionSnapshotDocSummary } from '@/types'
import { Button } from './Button'

// 会话快照 L1 档：结构 + cwd + 前台命令 + 尾部内容。
// 恢复只重放布局/目录/命令，进程不会复活；尾部内容是「历史回显」，只展示、不接受输入。
export function SessionSnapshotsDialog({
  open,
  onClose,
  hostId,
  activeSessionId,
  onRestored,
}: {
  open: boolean
  onClose: () => void
  hostId: string
  activeSessionId?: string | null
  onRestored?: (sessionName: string) => void
}) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [snapshots, setSnapshots] = useState<SessionSnapshotDocSummary[]>([])
  const [detail, setDetail] = useState<SessionSnapshotDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [replace, setReplace] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.sessionSnapshots.list(hostId)
      setSnapshots(data.snapshots)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('snapshot.loadFailed') })
    }
    setLoading(false)
  }, [hostId, pushToast, t])

  // 只在打开/换 host 时重置：把 load 放 ref 里，避免 t/pushToast 身份变化把已选中的详情清空
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!open) return
    setDetail(null)
    setReplace(false)
    void loadRef.current()
  }, [open, hostId])

  if (!open) return null

  const openDetail = async (snapshotId: string) => {
    setLoading(true)
    try {
      setDetail(await api.sessionSnapshots.get(hostId, snapshotId))
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('snapshot.loadFailed') })
    }
    setLoading(false)
  }

  const capture = async () => {
    if (!activeSessionId) return
    setBusy('capture')
    try {
      const snapshot = await api.sessionSnapshots.capture(hostId, activeSessionId)
      pushToast({ type: 'success', message: t('snapshot.captured') })
      setDetail(snapshot)
      await load()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('snapshot.captureFailed') })
    }
    setBusy(null)
  }

  const restore = async () => {
    if (!detail) return
    setBusy('restore')
    try {
      const result = await api.sessionSnapshots.restore(hostId, detail.id, { replace })
      pushToast({ type: 'success', message: t('snapshot.restored', { name: result.sessionName }) })
      onRestored?.(result.sessionName)
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('snapshot.restoreFailed') })
    }
    setBusy(null)
  }

  const remove = async (snapshotId: string) => {
    setBusy(snapshotId)
    try {
      await api.sessionSnapshots.remove(hostId, snapshotId)
      if (detail?.id === snapshotId) setDetail(null)
      await load()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('snapshot.deleteFailed') })
    }
    setBusy(null)
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center tmuxgo-scrim-strong p-4"
      onClick={onClose}
      data-testid="session-snapshots-dialog"
    >
      <div
        className="tmuxgo-glass tmuxgo-glass-dialog flex h-[75vh] w-full max-w-4xl flex-col overflow-hidden rounded-apple border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-base font-medium text-text-1">{t('snapshot.title')}</h3>
            {/* 红线：恢复≠复活进程，文案必须说清，不能让人以为能接回上次的运行状态 */}
            <p className="mt-0.5 text-xs text-text-3">{t('snapshot.restoreNotice')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => void capture()}
              disabled={!activeSessionId || busy !== null}
            >
              {t('snapshot.capture')}
            </Button>
            <Button variant="ghost" size="sm" aria-label="close" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
          <div className="tmuxgo-scrollbar overflow-y-auto border-b border-[var(--line)] md:border-b-0 md:border-r">
            {loading && !snapshots.length && <div className="p-4 text-sm text-text-3">{t('common.loading')}</div>}
            {!loading && !snapshots.length && <div className="p-4 text-sm text-text-3">{t('snapshot.empty')}</div>}
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className={`tmuxgo-list-row flex border-b border-[var(--line)] ${detail?.id === snapshot.id ? 'tmuxgo-list-row--active' : 'tmuxgo-list-row--hover'}`}
              >
                <button
                  onClick={() => void openDetail(snapshot.id)}
                  className="min-w-0 flex-1 p-3 text-left"
                  data-testid={`snapshot-item-${snapshot.id}`}
                >
                  <div className="truncate text-sm text-text-1">{snapshot.sessionName}</div>
                  <div className="mt-1 text-xs text-text-3">
                    {new Date(snapshot.createdAt).toLocaleString()} · {snapshot.stats.paneCount} pane ·{' '}
                    {Math.max(1, Math.round(snapshot.stats.bytes / 1024))} KB
                  </div>
                </button>
                <button
                  onClick={() => void remove(snapshot.id)}
                  className="w-10 text-text-3 hover:text-danger"
                  aria-label={t('snapshot.delete')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="tmuxgo-scrollbar min-h-0 overflow-y-auto p-4">
            {!detail && (
              <div className="flex h-full items-center justify-center text-sm text-text-3">
                {t('snapshot.selectHint')}
              </div>
            )}
            {detail && (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-medium text-text-1">{detail.sessionName}</div>
                    <div className="mt-1 text-xs text-text-3">
                      {new Date(detail.createdAt).toLocaleString()} · {detail.stats.paneCount} pane ·{' '}
                      {detail.stats.tailLines} {t('snapshot.linesUnit')} ·{' '}
                      {Math.max(1, Math.round(detail.stats.bytes / 1024))} KB
                    </div>
                    {detail.degraded.length > 0 && (
                      <div className="mt-1 text-xs text-warn" data-testid="snapshot-degraded">
                        {t('snapshot.degraded', { items: detail.degraded.join(', ') })}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-text-3">
                      <input
                        type="checkbox"
                        checked={replace}
                        onChange={(event) => setReplace(event.target.checked)}
                        data-testid="snapshot-replace"
                      />
                      {t('snapshot.replace')}
                    </label>
                    <Button variant="primary" size="sm" onClick={() => void restore()} disabled={busy !== null}>
                      {t('snapshot.restore')}
                    </Button>
                  </div>
                </div>
                {detail.panes.map((pane) => (
                  <div key={pane.tmuxPaneId}>
                    <div className="mb-1 flex items-center gap-2 text-xs text-text-3">
                      <span>
                        #{pane.paneIndex + 1} · {pane.title} · {pane.cwd || '-'} · {pane.command || '-'}
                        {pane.inMode ? ` · ${t('snapshot.inMode')}` : ''}
                      </span>
                      {/* 恢复后并不存在这段历史，明确标成回显，避免用户以为可以继续用 */}
                      <span className="rounded-full bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px] text-text-3">
                        {t('snapshot.historyEcho')}
                      </span>
                    </div>
                    <pre
                      className="overflow-x-auto whitespace-pre-wrap rounded-apple border border-[var(--line)] bg-bg-0 p-3 font-mono text-xs text-text-2"
                      data-testid={`snapshot-tail-${pane.paneIndex}`}
                    >
                      {pane.scrollbackTail || t('snapshot.noOutput')}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
