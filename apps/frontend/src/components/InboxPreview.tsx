'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { renderMarkdown, MARKDOWN_PROSE_CLASS } from '@/lib/markdown'
import { useInboxStore, inboxMessageTitle } from '@/stores/useInboxStore'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage } from '@/types'
import {
  FiArrowLeft,
  FiCornerUpRight,
  FiDownload,
  FiExternalLink,
  FiFile,
  FiPlay,
  FiShare2,
  FiZoomIn,
  FiZoomOut,
} from 'react-icons/fi'
import { Button } from './Button'
import { CsvTable } from './CsvTable'
import { InboxForwardDialog } from './InboxForwardDialog'
import { InboxShareDialog } from './InboxShareDialog'

// 文本类预览上限：再大会卡渲染也没必要——超出直接退到「下载」卡片
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024
const TEXT_RENDER_MAX_CHARS = 256 * 1024

function formatBytes(size?: number) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return ''
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

type PreviewKind = 'audio' | 'pdf' | 'csv' | 'markdown' | 'code' | 'unsupported'

const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'java',
  'kt',
  'sh',
  'bash',
  'zsh',
  'fish',
  'rb',
  'php',
  'lua',
  'sql',
  'css',
  'scss',
  'less',
  'xml',
  'html',
  'htm',
  'vue',
  'svelte',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'txt',
  'log',
  'diff',
  'patch',
  'dockerfile',
  'makefile',
  'mk',
  'gradle',
  'plist',
  'csv',
])
function fileExtension(name?: string) {
  const dot = (name || '').lastIndexOf('.')
  return dot > 0 ? name!.slice(dot + 1).toLowerCase() : ''
}
// 预览类型判定：mime 优先、扩展名兜底。svg 能携带脚本，一律按不可预览走下载；
// text/html 也只按源码文本展示（code 分支是转义文本，不执行）
function previewKind(message: AgentInboxMessage): PreviewKind {
  const mime = (message.mime || '').toLowerCase()
  const ext = fileExtension(message.name)
  if (mime === 'image/svg+xml' || ext === 'svg') return 'unsupported'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime === 'text/csv' || ext === 'csv') return 'csv'
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || CODE_EXTENSIONS.has(ext))
    return 'code'
  return 'unsupported'
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

function useInboxAssetText(messageId: string, enabled: boolean) {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    api.inbox
      .fetchAsset(messageId, controller.signal)
      .then((blob) => blob.text())
      .then((value) => {
        if (!controller.signal.aborted) setText(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [enabled, messageId, attempt])
  return { text, loading, error, retry: () => setAttempt((value) => value + 1) }
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

function LazyMediaGate({
  size,
  requested,
  onRequest,
  children,
}: {
  size?: number
  requested: boolean
  onRequest: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  if (requested) return <>{children}</>
  return (
    <div className="flex h-full items-center justify-center p-3">
      <button
        type="button"
        onClick={onRequest}
        className="tmuxgo-list-row flex items-center gap-2 rounded-apple border border-[var(--line)] bg-bg-2 px-4 py-3 text-sm text-text-1"
      >
        <FiPlay aria-hidden="true" />
        {t('inbox.loadMedia')}
        {formatBytes(size) && <span className="text-caption text-text-3">{formatBytes(size)}</span>}
      </button>
    </div>
  )
}

// 预览滚动记忆：切 tab 再切回时还原 scrollTop（text/code 分支共用同一容器约定）
function useRestoreScroll(messageId: string | undefined) {
  const ref = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !messageId) return
    const saved = useInboxStore.getState().previewScroll[messageId]
    if (saved) node.scrollTop = saved
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [messageId])
  const onScroll = () => {
    if (!messageId || !ref.current) return
    const top = ref.current.scrollTop
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => useInboxStore.getState().setPreviewScroll(messageId, top), 150)
  }
  return { ref, onScroll }
}

function ImagePreview({ url, alt }: { url: string; alt: string }) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const clamp = (value: number) => Math.min(8, Math.max(0.1, value))
  return (
    <div
      className="relative h-full overflow-auto p-3"
      onWheel={(event) => {
        // ctrl/cmd+滚轮缩放（触控板捏合也报 ctrlKey）
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        setZoom((value) => clamp(value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))
      }}
    >
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-apple border border-[var(--line)] bg-bg-1/90 px-1 py-0.5">
        <button
          type="button"
          aria-label={t('inbox.zoomOut')}
          title={t('inbox.zoomOut')}
          className="tmuxgo-toolbar-icon text-text-2"
          onClick={() => setZoom((value) => clamp(value / 1.25))}
        >
          <FiZoomOut aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          className="min-w-12 px-1 text-center text-caption text-text-2"
          onClick={() => setZoom(1)}
          title={t('inbox.zoomReset')}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label={t('inbox.zoomIn')}
          title={t('inbox.zoomIn')}
          className="tmuxgo-toolbar-icon text-text-2"
          onClick={() => setZoom((value) => clamp(value * 1.25))}
        >
          <FiZoomIn aria-hidden="true" size={14} />
        </button>
      </div>
      <div className={zoom === 1 ? 'flex h-full items-center justify-center' : ''}>
        <img
          src={url}
          alt={alt}
          onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
          className="rounded-apple"
          style={
            zoom === 1
              ? { maxWidth: '100%', maxHeight: '100%' }
              : { width: natural ? natural.w * zoom : undefined, maxWidth: 'none' }
          }
        />
      </div>
    </div>
  )
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
  const pushToast = useConsoleStore((state) => state.pushToast)
  const cached = useInboxStore((state) => state.messages.find((item) => item.id === messageId) || null)
  const [fetched, setFetched] = useState<AgentInboxMessage | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [mediaRequested, setMediaRequested] = useState(false)
  const [forwardOpen, setForwardOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const message = cached || fetched
  // kind 只用于 type=file 的细分（audio/pdf/text/code/csv/unsupported）
  const kind = message?.type === 'file' ? previewKind(message) : null
  // 视频/音频/pdf 统一走「点击加载」闸门，避免大文件一打开就整包拉下来
  const needsMediaGate = !!message?.assetId && (message.type === 'video' || kind === 'audio' || kind === 'pdf')
  const assetEnabled = !!message?.assetId && (message.type === 'image' || (needsMediaGate && mediaRequested))
  const asset = useInboxAsset(messageId, assetEnabled)
  const textEnabled =
    !!message?.assetId &&
    (kind === 'code' || kind === 'markdown' || kind === 'csv') &&
    (message.size || 0) <= TEXT_PREVIEW_MAX_BYTES
  const assetText = useInboxAssetText(messageId, textEnabled)
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
  // 换消息时重置媒体懒加载闸门
  useEffect(() => {
    setMediaRequested(false)
  }, [messageId])

  const scroll = useRestoreScroll(message?.id)

  const canJump = !!message && !!(message.route?.paneId || message.route?.tmuxPaneId || message.route?.sessionName)
  const title = message ? inboxMessageTitle(message) || message.id : ''

  const download = () => {
    if (!message?.assetId) return
    void downloadInboxAsset(message).catch((error) =>
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('inbox.download') }),
    )
  }

  const fileCard = (m: AgentInboxMessage, hint?: string) => (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-apple border border-[var(--line)] bg-bg-2 p-4">
        <div className="flex items-center gap-3">
          <FiFile aria-hidden="true" className="shrink-0 text-text-3" size={22} />
          <div className="min-w-0">
            <div className="truncate text-sm text-text-1">{m.name || title || m.id}</div>
            <div className="mt-0.5 text-caption text-text-3">
              {[m.mime, formatBytes(m.size)].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
        {hint && <div className="mt-2 text-xs text-text-3">{hint}</div>}
        {m.text && <div className="mt-2 line-clamp-3 text-xs text-text-2">{m.text}</div>}
        <Button variant="primary" size="sm" className="mt-3" onClick={download}>
          <FiDownload aria-hidden="true" className="mr-1 inline" />
          {t('inbox.download')}
        </Button>
      </div>
    </div>
  )

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
        <div ref={scroll.ref} onScroll={scroll.onScroll} className="tmuxgo-scrollbar h-full overflow-y-auto p-4">
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
      body = asset.url ? (
        <ImagePreview url={asset.url} alt={title} />
      ) : (
        <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
      )
    } else if (message.type === 'video') {
      body = (
        <LazyMediaGate size={message.size} requested={mediaRequested} onRequest={() => setMediaRequested(true)}>
          <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-3">
            {asset.url ? (
              <video src={asset.url} controls preload="metadata" className="max-h-full max-w-full rounded-apple" />
            ) : (
              <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
            )}
          </div>
        </LazyMediaGate>
      )
    } else if (kind === 'audio') {
      body = (
        <LazyMediaGate size={message.size} requested={mediaRequested} onRequest={() => setMediaRequested(true)}>
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
            {asset.url ? (
              <audio src={asset.url} controls preload="metadata" className="w-full max-w-md" />
            ) : (
              <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
            )}
            <div className="text-caption text-text-3">
              {message.name} · {formatBytes(message.size)}
            </div>
          </div>
        </LazyMediaGate>
      )
    } else if (kind === 'pdf') {
      body = (
        <LazyMediaGate size={message.size} requested={mediaRequested} onRequest={() => setMediaRequested(true)}>
          <div className="h-full p-2">
            {asset.url ? (
              <iframe
                src={asset.url}
                title={title}
                className="h-full w-full rounded-apple border border-[var(--line)] bg-bg-1"
              />
            ) : (
              <AssetState loading={asset.loading} error={asset.error} onRetry={asset.retry} />
            )}
          </div>
        </LazyMediaGate>
      )
    } else if (kind === 'markdown' || kind === 'code' || kind === 'csv') {
      if ((message.size || 0) > TEXT_PREVIEW_MAX_BYTES) {
        body = fileCard(message, t('inbox.previewTooLarge'))
      } else if (assetText.text !== null) {
        const truncated = assetText.text.length > TEXT_RENDER_MAX_CHARS
        const content = truncated ? assetText.text.slice(0, TEXT_RENDER_MAX_CHARS) : assetText.text
        if (kind === 'markdown') {
          body = (
            <div ref={scroll.ref} onScroll={scroll.onScroll} className="tmuxgo-scrollbar h-full overflow-y-auto p-4">
              <article className={MARKDOWN_PROSE_CLASS} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
              {truncated && (
                <div className="mt-2 text-caption text-text-3">
                  {t('inbox.truncated', { limit: `${TEXT_RENDER_MAX_CHARS / 1024}K` })}
                </div>
              )}
            </div>
          )
        } else if (kind === 'csv') {
          body = (
            <div className="flex h-full flex-col">
              <CsvTable content={content} emptyLabel={t('inbox.previewUnsupported')} />
              {truncated && (
                <div className="px-3 py-1 text-caption text-text-3">
                  {t('inbox.truncated', { limit: `${TEXT_RENDER_MAX_CHARS / 1024}K` })}
                </div>
              )}
            </div>
          )
        } else {
          body = (
            <div
              ref={scroll.ref}
              onScroll={scroll.onScroll}
              className="tmuxgo-scrollbar h-full overflow-auto bg-bg-1/60 p-4"
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-2">
                {content}
              </pre>
              {truncated && (
                <div className="mt-2 text-caption text-text-3">
                  {t('inbox.truncated', { limit: `${TEXT_RENDER_MAX_CHARS / 1024}K` })}
                </div>
              )}
            </div>
          )
        }
      } else {
        body = <AssetState loading={assetText.loading} error={assetText.error} onRetry={assetText.retry} />
      }
    } else {
      body = fileCard(message, t('inbox.previewUnsupported'))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--line)] px-2">
        {onClose && (
          <button
            type="button"
            aria-label={t('common.back')}
            title={t('common.back')}
            onClick={onClose}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--lg text-text-2"
          >
            <FiArrowLeft aria-hidden="true" size={18} />
          </button>
        )}
        <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-text-1">{title}</div>
        {message?.assetId && (
          <button
            type="button"
            aria-label={t('inbox.download')}
            title={t('inbox.download')}
            onClick={download}
            className="tmuxgo-toolbar-icon text-text-3 hover:text-text-1"
          >
            <FiDownload aria-hidden="true" size={15} />
          </button>
        )}
        {message && (message.assetId || message.type === 'text' || message.type === 'link') && (
          <button
            type="button"
            aria-label={t('inbox.forward')}
            title={t('inbox.forward')}
            onClick={() => setForwardOpen(true)}
            className="tmuxgo-toolbar-icon text-text-3 hover:text-text-1"
          >
            <FiCornerUpRight aria-hidden="true" size={15} />
          </button>
        )}
        {message && (
          <button
            type="button"
            aria-label={t('inbox.share')}
            title={t('inbox.share')}
            onClick={() => setShareOpen(true)}
            className="tmuxgo-toolbar-icon text-text-3 hover:text-text-1"
          >
            <FiShare2 aria-hidden="true" size={15} />
          </button>
        )}
        {canJump && onJump && (
          <Button variant="ghost" size="sm" onClick={() => message && onJump(message)}>
            {t('inbox.jump')}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">{body}</div>
      {forwardOpen && message && <InboxForwardDialog message={message} onClose={() => setForwardOpen(false)} />}
      {shareOpen && message && <InboxShareDialog message={message} onClose={() => setShareOpen(false)} />}
    </div>
  )
}
