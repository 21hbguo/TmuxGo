'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { getApiBase } from '@/lib/runtime-endpoints'
import { writeClipboardText } from '@/lib/clipboard-text'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { inboxMessageTitle } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage, InboxShare } from '@/types'
import { FiCopy, FiLink, FiShare2, FiX } from 'react-icons/fi'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'

const EXPIRY_OPTIONS = [
  { value: '10', labelKey: 'inbox.expiry10m' },
  { value: '60', labelKey: 'inbox.expiry1h' },
  { value: '1440', labelKey: 'inbox.expiry24h' },
  { value: '10080', labelKey: 'inbox.expiry7d' },
] as const

function formatExpiry(value: string) {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toLocaleString()
}

// 分享分两类：站内链接（/api/inbox/:id/asset，必须登录态）与外部链接
// （/s/i/:token，限时 + 可撤销 + 免登录）。绝不会把本机文件路径或鉴权
// token 当作分享物。navigator.share 取消不算错误，AbortError 静默。
export function InboxShareDialog({ message, onClose }: { message: AgentInboxMessage; onClose: () => void }) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((s) => s.pushToast)

  const isLink = message.type === 'link'
  const hasAsset = !!message.assetId
  const canSystemShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const canShareFiles =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator & { canShare?: unknown }).canShare === 'function'

  const [shares, setShares] = useState<InboxShare[]>([])
  const [expiry, setExpiry] = useState('60')
  const [creating, setCreating] = useState(false)
  const [createdUrl, setCreatedUrl] = useState('')
  const [sharingBusy, setSharingBusy] = useState(false)

  useEffect(() => {
    if (!hasAsset) return
    void api.inbox
      .listShares(message.id)
      .then((res) => setShares(res.shares || []))
      .catch(() => {})
  }, [hasAsset, message.id])

  const copyText = async (text: string) => {
    const result = await writeClipboardText(text)
    if (result.copied) pushToast({ type: 'success', message: t('inbox.copied') })
    else pushToast({ type: 'error', message: t('inbox.copyFailed') })
  }

  const systemShare = async () => {
    if (!canSystemShare) return
    setSharingBusy(true)
    try {
      if (hasAsset && canShareFiles) {
        const blob = await api.inbox.fetchAsset(message.id)
        const file = new File([blob], message.name || 'file', { type: message.mime || blob.type })
        const nav = navigator as Navigator & { canShare: (data: ShareData) => boolean }
        if (nav.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: inboxMessageTitle(message) || message.name })
          return
        }
      }
      const data: ShareData = { title: inboxMessageTitle(message) || 'TmuxGo' }
      if (isLink) data.url = message.text
      else data.text = message.text || message.name || ''
      await navigator.share(data)
    } catch (error) {
      // 用户取消是正常路径；其他失败提示一次即可
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        pushToast({ type: 'error', message: t('inbox.copyFailed') })
    } finally {
      setSharingBusy(false)
    }
  }

  const createLink = async () => {
    setCreating(true)
    try {
      const res = await api.inbox.createShare(message.id, Number(expiry))
      const url = `${getApiBase()}${res.path}`
      setCreatedUrl(url)
      setShares((current) => [res.share, ...current])
      pushToast({ type: 'success', message: t('inbox.shareCreated') })
      await copyText(url)
    } catch (error) {
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('inbox.share') })
    } finally {
      setCreating(false)
    }
  }
  const revoke = async (shareId: string) => {
    try {
      await api.inbox.revokeShare(shareId)
      setShares((current) => current.filter((share) => share.id !== shareId))
      pushToast({ type: 'info', message: t('inbox.shareRevoked') })
    } catch (error) {
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('inbox.share') })
    }
  }

  return (
    <ModalPortal modal onEscape={onClose}>
      <div className="fixed inset-0 z-[110] flex items-center justify-center tmuxgo-scrim p-4" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-4"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <FiShare2 aria-hidden="true" className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-1">{t('inbox.shareTitle')}</div>
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

          <div className="mt-4 flex flex-wrap gap-2">
            {(message.text || isLink) && (
              <Button variant="ghost" size="sm" onClick={() => void copyText(message.text || '')}>
                <FiCopy aria-hidden="true" className="mr-1 inline" />
                {isLink ? t('inbox.copyLink') : t('inbox.copyContent')}
              </Button>
            )}
            {canSystemShare && (message.text || hasAsset) && (
              <Button variant="ghost" size="sm" disabled={sharingBusy} onClick={() => void systemShare()}>
                <FiShare2 aria-hidden="true" className="mr-1 inline" />
                {t('inbox.systemShare')}
              </Button>
            )}
          </div>

          {hasAsset && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption text-text-3">{t('inbox.internalLinkNote')}</span>
                <Button variant="ghost" size="sm" onClick={() => void copyText(api.inbox.assetUrl(message.id))}>
                  <FiLink aria-hidden="true" className="mr-1 inline" />
                  {t('inbox.copyInternalLink')}
                </Button>
              </div>
              <div className="border-t border-[var(--line)]" />
              <div className="text-caption text-text-3">{t('inbox.shareExternalNote')}</div>
              <div className="flex items-center gap-2">
                <Select
                  value={expiry}
                  onChange={setExpiry}
                  variant="inline"
                  options={EXPIRY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                  aria-label={t('inbox.shareExternal')}
                />
                <Button variant="primary" size="sm" disabled={creating} onClick={() => void createLink()}>
                  {creating ? t('common.loading') : t('inbox.shareCreate')}
                </Button>
              </div>
              {createdUrl && (
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={createdUrl}
                    onFocus={(event) => event.target.select()}
                    className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-2 py-1 font-mono text-xs"
                  />
                  <Button variant="ghost" size="sm" onClick={() => void copyText(createdUrl)}>
                    {t('inbox.copyLink')}
                  </Button>
                </div>
              )}
              {!!shares.length && (
                <div className="space-y-1">
                  {shares.map((share) => (
                    <div key={share.id} className="flex items-center gap-2 text-caption text-text-2">
                      <span className="min-w-0 flex-1 truncate">
                        {t('inbox.shareExpires', { time: formatExpiry(share.expiresAt) })}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-danger hover:underline"
                        onClick={() => void revoke(share.id)}
                      >
                        {t('inbox.shareRevoke')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!shares.length && !createdUrl && (
                <div className="text-caption text-text-3/70">{t('inbox.shareNone')}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  )
}
