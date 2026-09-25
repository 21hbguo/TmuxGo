'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { renderMarkdown, MARKDOWN_PROSE_CLASS } from '@/lib/markdown'
import { useInboxStore, inboxMessageTitle } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage } from '@/types'
import { FiArrowLeft, FiDownload, FiExternalLink, FiFile, FiPlay } from 'react-icons/fi'
import { Button } from './Button'

function formatBytes(size?: number) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return ''
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

// 二进制一律经 REST blob 拉取（asset 接口要 Authorization，img/video 直链带不上头）；
// 卸载时 abort 在途请求 + revoke object URL，防泄漏与悬置写状态
function useInboxAsset(messageId: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    setLoading(true)
    setError(false)
    api.inbox
      .fetchAsset(messageId, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [enabled, messageId, attempt])
  return { url, loading, error, retry: () => setAttempt((value) => value + 1) }
}

async function downloadInboxAsset(message: AgentInboxMessage) {
  const blob = await api.inbox.fetchAsset(message.id)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = message.name || 'file'
  anchor.click()
  // 延后 revoke：click 同步触发下载，立即回收会让部分浏览器拿到失效 URL
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function AssetState({ loading, error, onRetry }: { loading: boolean; error: boolean; onRetry: () => void }) {
  const { t } = useTranslation()
  if (error)
    return (
      <div className="flex h-full items-center justify-center">
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    )
  if (loading)
    return <div className="flex h-full items-center justify-center text-sm text-text-3">{t('common.loading')}</div>
  return null
}

export function InboxPreview({
  messageId,
  onClose,
  onJump,
}: {
  messageId: string
  onClose?: () => void
  onJump?: (message: AgentInboxMessage) => void
}) {
  const { t } = useTranslation()
  const cached = useInboxStore((state) => state.messages.find((item) => item.id === messageId) || null)
  const [fetched, setFetched] = useState<AgentInboxMessage | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [videoRequested, setVideoRequested] = useState(false)
  const message = cached || fetched
  // 打开预览即标已读（幂等：已读时 changed=0 不发请求）
  useEffect(() => {
    if (!message) return
    const store = useInboxStore.getState()
    if (!message.readBy.includes(store.deviceId)) {
      store.markReadLocal([message.id])
      void api.inbox.markRead(message.id, store.deviceId).catch(() => {})
    }
  }, [message])
  useEffect(() => {
    if (cached || fetched || loadError) return
    let cancelled = false
    api.inbox
      .get(messageId)
      .then((res) => {
        if (!cancelled) setFetched(res.message)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [cached, fetched, loadError, messageId])
  const assetEnabled = !!message?.assetId && (message.type === 'image' || (message.type === 'video' && videoRequested))
  const asset = useInboxAsset(messageId, assetEnabled)

  const canJump = !!message && !!(message.route?.paneId || message.route?.tmuxPaneId || message.route?.sessionName)
  const title = message ? inboxMessageTitle(message) || message.id : ''

  let body: React.ReactNode
  if (loadError || (!message && !cached)) {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-text-3">
        {loadError ? t('inbox.expired') : t('common.loading')}
      </div>
    )
  } else if (message) {
    if (message.type === 'text') {
      body = (
        <div className="tmuxgo-scrollbar h-full overflow-y-auto p-4">
          {message.title && <h3 className="mb-3 text-base font-medium text-text-1">{message.title}</h3>}
          <article
            className={MARKDOWN_PROSE_CLASS}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text || '') }}
          />
        </div>
      )
    } else if (message.type === 'link') {
      body = (
        <div className="flex h-full items-center justify-center p-6">
          <a
            href={message.text}
            target="_blank"
            rel="noopener noreferrer"
            className="tmuxgo-list-row flex w-full max-w-md items-center gap-3 rounded-apple border border-[var(--line)] bg-bg-2 p-4 text-left"
          >
            <FiExternalLink aria-hidden="true" className="shrink-0 text-accent" size={20} />
            <span className="min-w-0">
              <span className="block truncate text-sm text-text-1">{message.title || message.text}</span>
              <span className="mt-0.5 block truncate text-caption text-text-3">{message.text}</span>
            </span>
          </a>
        </div>
      )
    } else if (message.type === 'image') {
      body = (
        <div className="relative flex h-full items-center justify-center overflow-auto p-3">
          {asset.url ? (
            <img src={asset.url} alt={title} loading="lazy" className="max-h-full max-w-full rounded-apple" />
          ) : (
            <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
          )}
        </div>
      )
    } else if (message.type === 'video') {
      body = (
        <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-3">
          {asset.url ? (
            <video src={asset.url} controls preload="metadata" className="max-h-full max-w-full rounded-apple" />
          ) : videoRequested ? (
            <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
          ) : (
            <button
              type="button"
              onClick={() => setVideoRequested(true)}
              className="tmuxgo-list-row flex items-center gap-2 rounded-apple border border-[var(--line)] bg-bg-2 px-4 py-3 text-sm text-text-1"
            >
              <FiPlay aria-hidden="true" />
              {t('inbox.loadMedia')}
              {formatBytes(message.size) && (
                <span className="text-caption text-text-3">{formatBytes(message.size)}</span>
              )}
            </button>
          )}
        </div>
      )
    } else {
      body = (
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-md rounded-apple border border-[var(--line)] bg-bg-2 p-4">
            <div className="flex items-center gap-3">
              <FiFile aria-hidden="true" className="shrink-0 text-text-3" size={22} />
              <div className="min-w-0">
                <div className="truncate text-sm text-text-1">{message.name || title || message.id}</div>
                <div className="mt-0.5 text-caption text-text-3">
                  {[message.mime, formatBytes(message.size)].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
            {message.text && <div className="mt-2 text-xs text-text-2">{message.text}</div>}
            <Button variant="primary" size="sm" className="mt-3" onClick={() => void downloadInboxAsset(message)}>
              <FiDownload aria-hidden="true" className="mr-1 inline" />
              {t('inbox.download')}
            </Button>
          </div>
        </div>
      )
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onClose && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-2">
          <button
            type="button"
            aria-label={t('common.back')}
            title={t('common.back')}
            onClick={onClose}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--lg text-text-2"
          >
            <FiArrowLeft aria-hidden="true" size={18} />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">{title}</div>
          {canJump && onJump && (
            <Button variant="ghost" size="sm" onClick={() => message && onJump(message)}>
              {t('inbox.jump')}
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )
}
