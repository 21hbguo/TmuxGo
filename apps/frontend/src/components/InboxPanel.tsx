'use client'

import { useEffect, useMemo, useState } from 'react'
import { useInboxStore, inboxMessageTitle } from '@/stores/useInboxStore'
import { refreshInboxList, markInboxRead, deleteInboxMessages } from '@/hooks/useInbox'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { api } from '@/lib/api'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage, InboxFilter, InboxMessageType } from '@/types'
import {
  FiCheck,
  FiCornerUpRight,
  FiDownload,
  FiExternalLink,
  FiFile,
  FiFileText,
  FiFilter,
  FiImage,
  FiInbox,
  FiLink,
  FiPaperclip,
  FiSearch,
  FiShare2,
  FiTrash2,
  FiVideo,
  FiX,
} from 'react-icons/fi'
import { Button } from './Button'
import { Select } from './Select'
import { InboxPreview } from './InboxPreview'
import { InboxForwardDialog } from './InboxForwardDialog'
import { InboxShareDialog } from './InboxShareDialog'

const TYPE_ICONS = {
  text: FiFileText,
  image: FiImage,
  video: FiVideo,
  file: FiFile,
  link: FiLink,
} as const

const FILTER_TYPES: (InboxMessageType | 'all')[] = ['all', 'text', 'image', 'video', 'file', 'link']
const TYPE_LABEL_KEYS = {
  all: 'inbox.typeAll',
  text: 'inbox.typeText',
  image: 'inbox.typeImage',
  video: 'inbox.typeVideo',
  file: 'inbox.typeFile',
  link: 'inbox.typeLink',
} as const

function routeLabel(message: AgentInboxMessage) {
  const route = message.route || {}
  if (route.paneId) return route.paneId
  if (route.tmuxPaneId) return `${route.hostId || ''}:${route.tmuxPaneId}`
  if (route.sessionName) return route.sessionName
  return ''
}
function canJump(message: AgentInboxMessage) {
  const route = message.route || {}
  return !!(route.paneId || route.tmuxPaneId || route.sessionName)
}
// 高密度列表的时间戳：当天只留时分，跨年留月日，不整段 toLocaleString
function formatTime(value: string) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  const date = new Date(time)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return date.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
}
function formatBytes(size?: number) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return ''
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}M`
  if (size >= 1024) return `${(size / 1024).toFixed(0)}K`
  return `${size}B`
}

// 单行可辨识所需 haystack：标题/文件名/来源/route/正文摘要（上限截断防大文本卡搜索）
function matchesQuery(message: AgentInboxMessage, query: string) {
  const haystack = [
    inboxMessageTitle(message),
    message.name || '',
    message.source?.agent || '',
    message.source?.provider || '',
    message.route?.sessionName || '',
    message.route?.paneId || '',
    message.route?.tmuxPaneId || '',
    (message.text || '').slice(0, 4096),
  ]
    .join('\n')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

async function downloadAsset(message: AgentInboxMessage) {
  const blob = await api.inbox.fetchAsset(message.id)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = message.name || 'file'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface InboxPanelProps {
  mode: 'desktop' | 'mobile'
  onClose: () => void
  onPreview?: (message: AgentInboxMessage) => void
  onJump?: (message: AgentInboxMessage) => void
}

export function InboxPanel({ mode, onClose, onPreview, onJump }: InboxPanelProps) {
  useEscapeClose(onClose, mode === 'desktop')
  const { t } = useTranslation()
  const messages = useInboxStore((state) => state.messages)
  const unreadCount = useInboxStore((state) => state.unreadCount)
  const deviceId = useInboxStore((state) => state.deviceId)
  const nextCursor = useInboxStore((state) => state.nextCursor)
  const listLoaded = useInboxStore((state) => state.listLoaded)
  const tabs = useInboxStore((state) => state.tabs)
  const activeTabId = useInboxStore((state) => state.activeTabId)
  const filter = useInboxStore((state) => state.filter)
  const openTab = useInboxStore((state) => state.openTab)
  const closeTab = useInboxStore((state) => state.closeTab)
  const setActiveTab = useInboxStore((state) => state.setActiveTab)
  const togglePinTab = useInboxStore((state) => state.togglePinTab)
  const setFilter = useInboxStore((state) => state.setFilter)
  const [forwardMessage, setForwardMessage] = useState<AgentInboxMessage | null>(null)
  const [shareMessage, setShareMessage] = useState<AgentInboxMessage | null>(null)

  // 打开面板即拉最新一页（WS 事件只带增量 metadata，首次/断线靠 REST 补齐）
  useEffect(() => {
    void refreshInboxList().catch(() => {})
  }, [])

  const filtered = useMemo(
    () =>
      messages.filter((message) => {
        if (filter.unreadOnly && deviceId && message.readBy.includes(deviceId)) return false
        if (filter.type !== 'all' && message.type !== filter.type) return false
        if (filter.query.trim() && !matchesQuery(message, filter.query.trim())) return false
        return true
      }),
    [messages, filter, deviceId],
  )

  const openMessage = (message: AgentInboxMessage) => {
    openTab(message)
    markInboxRead([message.id])
    if (mode === 'mobile') onPreview?.(message)
  }
  const markAllRead = () => {
    const ids = messages.filter((item) => !item.readBy.includes(deviceId)).map((item) => item.id)
    if (ids.length) markInboxRead(ids)
  }

  const rowAction = (label: string, Icon: typeof FiCheck, onClick: () => void, hoverClass = 'hover:text-accent') => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`tmuxgo-toolbar-icon shrink-0 text-text-3 ${hoverClass}`}
    >
      <Icon aria-hidden="true" size={14} />
    </button>
  )

  const list = (
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
      {listLoaded && !filtered.length && (
        <div className="flex flex-col items-center gap-2 px-2 py-8 text-sm text-text-3">
          <FiInbox aria-hidden="true" size={22} />
          {messages.length ? t('inbox.noMatch') : t('inbox.empty')}
        </div>
      )}
      {filtered.map((message) => {
        const Icon = TYPE_ICONS[message.type] || FiFileText
        const unread = !!deviceId && !message.readBy.includes(deviceId)
        const title = inboxMessageTitle(message) || message.id
        const source = message.source?.agent || message.source?.provider || ''
        const route = routeLabel(message)
        return (
          <div
            key={message.id}
            className={`group flex items-center gap-1 rounded-apple border px-1 ${
              unread ? 'border-accent/40 bg-accent/5' : 'border-transparent'
            } ${activeTabId === message.id && mode === 'desktop' ? 'bg-accent/10' : 'hover:bg-bg-2'} ${
              mode === 'mobile' ? 'mb-0.5 min-h-11' : 'mb-0.5 h-8'
            }`}
          >
            <button
              type="button"
              onClick={() => openMessage(message)}
              className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left ${mode === 'mobile' ? 'flex-wrap' : ''}`}
            >
              <Icon aria-hidden="true" className="shrink-0 text-text-3" size={13} />
              {unread && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label={t('inbox.unreadDot')} />
              )}
              <span className={`min-w-0 truncate text-sm ${unread ? 'font-medium text-text-1' : 'text-text-2'}`}>
                {title}
              </span>
              {message.assetId && (
                <span className="flex shrink-0 items-center gap-0.5 text-caption text-text-3" title={message.name}>
                  <FiPaperclip aria-hidden="true" size={11} />
                  {formatBytes(message.size)}
                </span>
              )}
              {source && (
                <span className="hidden min-w-0 max-w-28 truncate text-caption text-text-3 sm:inline">{source}</span>
              )}
              {route && (
                <span className="hidden min-w-0 max-w-28 truncate text-caption text-text-3/70 md:inline">·{route}</span>
              )}
              <span className="ml-auto shrink-0 text-caption text-text-3/70">{formatTime(message.createdAt)}</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              {message.assetId && rowAction(t('inbox.download'), FiDownload, () => void downloadAsset(message))}
              {(message.assetId || message.type === 'text' || message.type === 'link') &&
                mode === 'desktop' &&
                rowAction(t('inbox.forward'), FiCornerUpRight, () => setForwardMessage(message), 'hover:text-text-1')}
              {mode === 'desktop' &&
                rowAction(t('inbox.share'), FiShare2, () => setShareMessage(message), 'hover:text-text-1')}
              {canJump(message) && onJump && rowAction(t('inbox.jump'), FiExternalLink, () => onJump(message))}
              {unread &&
                rowAction(t('inbox.markRead'), FiCheck, () => markInboxRead([message.id]), 'hover:text-accent-2')}
              {rowAction(t('inbox.delete'), FiTrash2, () => deleteInboxMessages([message.id]), 'hover:text-danger')}
            </div>
          </div>
        )
      })}
      {nextCursor && (
        <div className="p-1.5 text-center">
          <Button variant="ghost" size="sm" onClick={() => void refreshInboxList(nextCursor).catch(() => {})}>
            {t('inbox.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )

  const header = (
    <div className="shrink-0 border-b border-[var(--line)]">
      <div className="flex h-10 items-center gap-2 px-3">
        {mode === 'mobile' && (
          <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-text-3/30" />
        )}
        <h2 className="text-sm font-medium text-text-1">
          {t('inbox.title')}
          {unreadCount > 0 && <span className="ml-1.5 text-caption text-accent">{unreadCount}</span>}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              {t('inbox.markAllRead')}
            </Button>
          )}
          <button
            type="button"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--lg text-text-3"
          >
            <FiX aria-hidden="true" size={18} />
          </button>
        </div>
      </div>
      <div className="flex h-9 items-center gap-1.5 px-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <FiSearch
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-3"
            size={13}
          />
          <input
            value={filter.query}
            onChange={(event) => setFilter({ query: event.target.value })}
            placeholder={t('inbox.search')}
            aria-label={t('inbox.search')}
            className="tmuxgo-control tmuxgo-input h-7 w-full rounded-apple pl-7 pr-2 text-xs"
          />
        </div>
        <Select
          value={filter.type}
          onChange={(value) => setFilter({ type: value as InboxFilter['type'] })}
          variant="inline"
          options={FILTER_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL_KEYS[type]) }))}
          aria-label={t('inbox.typeAll')}
        />
        <button
          type="button"
          aria-pressed={filter.unreadOnly}
          title={t('inbox.unreadOnly')}
          onClick={() => setFilter({ unreadOnly: !filter.unreadOnly })}
          className={`tmuxgo-toolbar-icon shrink-0 ${filter.unreadOnly ? 'text-accent' : 'text-text-3'}`}
        >
          <FiFilter aria-hidden="true" size={14} />
        </button>
        <span className="shrink-0 text-caption text-text-3/70">
          {t('inbox.count', { shown: filtered.length, total: messages.length })}
        </span>
      </div>
    </div>
  )

  if (mode === 'mobile') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {header}
        {list}
        {forwardMessage && <InboxForwardDialog message={forwardMessage} onClose={() => setForwardMessage(null)} />}
        {shareMessage && <InboxShareDialog message={shareMessage} onClose={() => setShareMessage(null)} />}
      </div>
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center tmuxgo-scrim p-4" onMouseDown={onClose}>
      <section
        className="tmuxgo-glass tmuxgo-glass-dialog flex h-[min(680px,calc(100dvh-32px))] w-full max-w-5xl flex-col overflow-hidden rounded-apple border sm:flex-row"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-44 w-full shrink-0 flex-col border-b border-[var(--line)] bg-bg-1 sm:h-auto sm:w-80 sm:border-b-0 sm:border-r">
          {header}
          {list}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!!tabs.length && (
            <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--line)] px-2 scrollbar-none">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`group flex h-7 max-w-44 shrink-0 items-center gap-1 rounded-t-apple border border-b-0 px-2 text-xs ${
                    tab.id === activeTabId
                      ? 'border-[var(--line)] bg-bg-0 text-text-1'
                      : 'border-transparent text-text-3 hover:text-text-1'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    onDoubleClick={() => togglePinTab(tab.id)}
                    title={tab.title}
                    className="min-w-0 truncate"
                  >
                    {tab.pinned ? '★ ' : ''}
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    aria-label={t('common.close')}
                    onClick={() => closeTab(tab.id)}
                    className="shrink-0 text-text-3 hover:text-text-1"
                  >
                    <FiX aria-hidden="true" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {activeTab ? (
              <InboxPreview messageId={activeTab.messageId} onJump={onJump} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-text-3">{t('inbox.noPreview')}</div>
            )}
          </div>
        </div>
      </section>
      {forwardMessage && <InboxForwardDialog message={forwardMessage} onClose={() => setForwardMessage(null)} />}
      {shareMessage && <InboxShareDialog message={shareMessage} onClose={() => setShareMessage(null)} />}
    </div>
  )
}
