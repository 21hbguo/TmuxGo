'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { inboxMessageTitle } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage, Host } from '@/types'
import { FiCornerUpRight, FiX } from 'react-icons/fi'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'

// 转发语义：文本/链接 → 粘贴进当前活动 pane（走 PasteConfirmDialog 二次确认，
// 绝不自动执行）；附件 → 以原文件名落到目标主机目录（UploadConfirmDialog 决定
// 最终路径）。附件始终经 REST blob 复用已存 asset，不会重复上传回 gateway。
export function InboxForwardDialog({ message, onClose }: { message: AgentInboxMessage; onClose: () => void }) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const activePaneId = useConsoleStore((s) => s.activePaneId)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)

  const isTextLike = message.type === 'text' || message.type === 'link'
  const hasAsset = !!message.assetId
  const sourcePaneId = message.route?.paneId || ''
  const sourceHostId =
    message.route?.hostId || (sourcePaneId.includes(':') ? sourcePaneId.split(':')[0] : '') || 'local'
  // default-upload-target 的 paneId 直传 `tmux -t`：必须是 %N 原生目标，
  // route.paneId 带 host 前缀的要剥掉
  const sourcePaneTarget =
    message.route?.tmuxPaneId || (sourcePaneId.includes(':') ? sourcePaneId.split(':').pop() : '') || ''

  const [hosts, setHosts] = useState<Host[]>([])
  const [hostId, setHostId] = useState(sourceHostId)
  const [target, setTarget] = useState<'default' | 'pane'>(sourcePaneTarget ? 'pane' : 'default')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.hosts
      .list()
      .then((list) => setHosts((list as Host[]).filter((host) => host.status === 'online' || host.id === 'local')))
      .catch(() => setHosts([]))
  }, [])

  const forwardToPane = () => {
    if (!activePaneId) {
      pushToast({ type: 'error', message: t('inbox.forwardNoPane') })
      return
    }
    // 粘贴确认由 ClipboardController 统一弹（多行/控制字符检查 + 手动确认），
    // 这里只投递意图，不直接写终端
    window.dispatchEvent(
      new CustomEvent('tmuxgo-request-terminal-paste', {
        detail: { text: message.text || '', source: 'memory' },
      }),
    )
    onClose()
  }

  const forwardFile = async () => {
    if (!message.assetId) return
    setBusy(true)
    try {
      const paneId = target === 'pane' ? (sourceHostId === hostId ? sourcePaneTarget : '') || undefined : undefined
      const resolved = await api.files.defaultUploadTarget(hostId, paneId)
      const blob = await api.inbox.fetchAsset(message.id)
      const file = new File([blob], message.name || 'file', { type: message.mime || blob.type })
      openUploadDialog({
        files: [file],
        hostId,
        preferredRootId: resolved.rootId,
        preferredPath: resolved.path,
        insertPaths: false,
      })
      pushToast({ type: 'info', message: t('inbox.forwardStarted') })
      onClose()
    } catch (error) {
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('inbox.forwardFailed') })
    } finally {
      setBusy(false)
    }
  }

  const hostOptions = hosts.length
    ? hosts.map((host) => ({ value: host.id, label: host.name || host.id }))
    : [{ value: 'local', label: 'local' }]

  return (
    <ModalPortal modal onEscape={onClose}>
      <div className="fixed inset-0 z-[110] flex items-center justify-center tmuxgo-scrim p-4" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-4"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <FiCornerUpRight aria-hidden="true" className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-1">{t('inbox.forwardTitle')}</div>
              <div className="truncate text-caption text-text-3">{inboxMessageTitle(message) || message.id}</div>
            </div>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--lg text-text-3"
            >
              <FiX aria-hidden="true" size={16} />
            </button>
          </div>

          {isTextLike && (
            <div className="mt-4">
              <Button variant="primary" size="sm" className="w-full" onClick={forwardToPane} disabled={!activePaneId}>
                {t('inbox.forwardToPane')}
                {activePaneId ? ` · ${activePaneId}` : ''}
              </Button>
              {!activePaneId && <div className="mt-2 text-caption text-text-3">{t('inbox.forwardNoPane')}</div>}
            </div>
          )}

          {hasAsset && (
            <div className="mt-4 space-y-3">
              <div className="text-caption text-text-3">{t('inbox.forwardToHost')}</div>
              <Select value={hostId} onChange={setHostId} options={hostOptions} aria-label={t('inbox.forwardTitle')} />
              <label className="flex items-center gap-2 text-sm text-text-2">
                <input
                  type="radio"
                  name="inbox-forward-target"
                  checked={target === 'default'}
                  onChange={() => setTarget('default')}
                  className="accent-[rgb(var(--accent))]"
                />
                {t('inbox.forwardDefaultTarget')}
              </label>
              <label
                className={`flex items-center gap-2 text-sm ${sourcePaneTarget ? 'text-text-2' : 'text-text-3 opacity-60'}`}
              >
                <input
                  type="radio"
                  name="inbox-forward-target"
                  disabled={!sourcePaneTarget}
                  checked={target === 'pane'}
                  onChange={() => setTarget('pane')}
                  className="accent-[rgb(var(--accent))]"
                />
                {sourcePaneTarget ? sourcePaneTarget : t('inbox.forwardNoPane')}
              </label>
              <Button variant="primary" size="sm" className="w-full" disabled={busy} onClick={() => void forwardFile()}>
                {busy ? t('common.loading') : t('inbox.forward')}
              </Button>
            </div>
          )}
          {!isTextLike && !hasAsset && <div className="mt-4 text-sm text-text-3">{t('inbox.previewUnsupported')}</div>}
        </div>
      </div>
    </ModalPortal>
  )
}
