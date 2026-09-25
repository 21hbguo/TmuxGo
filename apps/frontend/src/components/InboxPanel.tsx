'use client'

import { useEffect } from 'react'
import { useInboxStore, inboxMessageTitle } from '@/stores/useInboxStore'
import { refreshInboxList, markInboxRead, deleteInboxMessages } from '@/hooks/useInbox'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { useTranslation } from '@/i18n'
import type { AgentInboxMessage } from '@/types'
import {
  FiCheck,
  FiExternalLink,
  FiFile,
  FiFileText,
  FiImage,
  FiInbox,
  FiLink,
  FiTrash2,
  FiVideo,
  FiX,
} from 'react-icons/fi'
import { Button } from './Button'
import { InboxPreview } from './InboxPreview'

const TYPE_ICONS = {
  text: FiFileText,
  image: FiImage,
  video: FiVideo,
  file: FiFile,
  link: FiLink,
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
function formatTime(value: string) {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toLocaleString()
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
  const openTab = useInboxStore((state) => state.openTab)
  const closeTab = useInboxStore((state) => state.closeTab)
  const setActiveTab = useInboxStore((state) => state.setActiveTab)
  const togglePinTab = useInboxStore((state) => state.togglePinTab)

  // 打开面板即拉最新一页（WS 事件只带增量 metadata，首次/断线靠 REST 补齐）
  useEffect(() => {
    void refreshInboxList().catch(() => {})
  }, [])

  const openMessage = (message: AgentInboxMessage) => {
    openTab(message)
    markInboxRead([message.id])
    if (mode === 'mobile') onPreview?.(message)
  }
  const markAllRead = () => {
    const ids = messages.filter((item) => !item.readBy.includes(deviceId)).map((item) => item.id)
    if (ids.length) markInboxRead(ids)
  }

  const list = (
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
      {listLoaded && !messages.length && (
        <div className="flex flex-col items-center gap-2 px-2 py-8 text-sm text-text-3">
          <FiInbox aria-hidden="true" size={22} />
          {t('inbox.empty')}
        </div>
      )}
      {messages.map((message) => {
        const Icon = TYPE_ICONS[message.type] || FiFileText
        const unread = !!deviceId && !message.readBy.includes(deviceId)
        const title = inboxMessageTitle(message) || message.id
        const route = routeLabel(message)
        return (
          <div
            key={message.id}
            className={`group mb-1 flex items-stretch rounded-apple border ${
              unread ? 'border-accent/40 bg-accent/5' : 'border-transparent'
            } ${activeTabId === message.id && mode === 'desktop' ? 'bg-accent/10' : 'hover:bg-bg-2'}`}
          >
            <button type="button" onClick={() => openMessage(message)} className="min-w-0 flex-1 p-2 text-left">
              <span className="flex items-center gap-1.5 text-caption">
                <Icon aria-hidden="true" className="shrink-0 text-text-3" />
                {unread && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label={t('inbox.unreadDot')} />
                )}
                <span className="truncate text-text-3">{message.source?.agent || message.source?.provider || ''}</span>
                {route && <span className="truncate text-text-3/70">· {route}</span>}
                <span className="ml-auto shrink-0 text-text-3/70">{formatTime(message.createdAt)}</span>
              </span>
              <span className={`mt-1 block truncate text-sm ${unread ? 'font-medium text-text-1' : 'text-text-2'}`}>
                {title}
              </span>
              {message.type !== 'text' && message.name && (
                <span className="mt-0.5 block truncate text-caption text-text-3">{message.name}</span>
              )}
            </button>
            <div className="flex shrink-0 flex-col justify-center gap-0.5 pr-1">
              {canJump(message) && onJump && (
                <button
                  type="button"
                  aria-label={t('inbox.jump')}
                  title={t('inbox.jump')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onJump(message)
                  }}
                  className="tmuxgo-toolbar-icon text-text-3 hover:text-accent"
                >
                  <FiExternalLink aria-hidden="true" size={14} />
                </button>
              )}
              {unread && (
                <button
                  type="button"
                  aria-label={t('inbox.markRead')}
                  title={t('inbox.markRead')}
                  onClick={(event) => {
                    event.stopPropagation()
                    markInboxRead([message.id])
                  }}
                  className="tmuxgo-toolbar-icon text-text-3 hover:text-accent-2"
                >
                  <FiCheck aria-hidden="true" size={14} />
                </button>
              )}
              <button
                type="button"
                aria-label={t('inbox.delete')}
                title={t('inbox.delete')}
                onClick={(event) => {
                  event.stopPropagation()
                  deleteInboxMessages([message.id])
                }}
                className="tmuxgo-toolbar-icon text-text-3 hover:text-danger"
              >
                <FiTrash2 aria-hidden="true" size={14} />
              </button>
            </div>
          </div>
        )
      })}
      {nextCursor && (
        <div className="p-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => void refreshInboxList(nextCursor).catch(() => {})}>
            {t('inbox.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
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
  )

  if (mode === 'mobile') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {header}
        {list}
      </div>
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center tmuxgo-scrim p-4" onMouseDown={onClose}>
      <section
        className="tmuxgo-glass tmuxgo-glass-dialog flex h-[min(640px,calc(100dvh-32px))] w-full max-w-4xl flex-col overflow-hidden rounded-apple border sm:flex-row"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-44 w-full shrink-0 flex-col border-b border-[var(--line)] bg-bg-1 sm:h-auto sm:w-72 sm:border-b-0 sm:border-r">
          {header}
          {list}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!!tabs.length && (
            <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--line)] px-2 scrollbar-none">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`group flex h-8 max-w-44 shrink-0 items-center gap-1 rounded-t-apple border border-b-0 px-2 text-xs ${
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
    </div>
  )
}
