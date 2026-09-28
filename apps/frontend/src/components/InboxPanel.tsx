'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useInboxStore, inboxMessageTitle, isInboxUnread, isInboxArchivable } from '@/stores/useInboxStore'
import { useConsoleStore } from '@/stores/useConsoleStore'
import {
  refreshInboxList,
  markInboxRead,
  deleteInboxMessages,
  restoreInboxMessages,
  purgeInboxMessages,
  archiveInboxMessages,
} from '@/hooks/useInbox'
import { useModalLayer } from '@/hooks/useModalLayer'
import { api } from '@/lib/api'
import { useTranslation } from '@/i18n'
import type {
  AgentInboxMessage,
  InboxFilter,
  InboxMessageType,
  InboxRangeFilter,
  InboxStatusFilter,
  InboxViewFilter,
} from '@/types'
import {
  FiCheck,
  FiCornerUpRight,
  FiDownload,
  FiExternalLink,
  FiFile,
  FiFileText,
  FiImage,
  FiInbox,
  FiLink,
  FiMail,
  FiPaperclip,
  FiRotateCcw,
  FiSearch,
  FiShare2,
  FiTrash2,
  FiVideo,
  FiX,
} from 'react-icons/fi'
import { Button } from './Button'
import { Select } from './Select'
import { ConfirmDialog } from './ConfirmDialog'
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
const VIEW_OPTIONS: InboxViewFilter[] = ['active', 'archived', 'trash']
const VIEW_LABEL_KEYS = {
  active: 'inbox.viewActive',
  archived: 'inbox.viewArchived',
  trash: 'inbox.viewTrash',
} as const
const STATUS_OPTIONS: InboxStatusFilter[] = ['all', 'unread', 'read']
const STATUS_LABEL_KEYS = {
  all: 'inbox.statusAll',
  unread: 'inbox.statusUnread',
  read: 'inbox.statusRead',
} as const
const RANGE_OPTIONS: InboxRangeFilter[] = ['all', '1d', '7d', '30d']
const RANGE_LABEL_KEYS = {
  all: 'inbox.rangeAll',
  '1d': 'inbox.range1d',
  '7d': 'inbox.range7d',
  '30d': 'inbox.range30d',
} as const
const RANGE_MS: Record<Exclude<InboxRangeFilter, 'all'>, number> = {
  '1d': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
}

function routeLabel(message: AgentInboxMessage) {
  const route = message.route || {}
  if (route.paneId) return route.paneId
  if (route.tmuxPaneId) return `${route.hostId || ''}:${route.tmuxPaneId}`
  if (route.sessionName) return route.sessionName
  return ''
}
// 来源筛选的匹配键：agent/provider 名与路由标签都进同一个下拉
function sourceKey(message: AgentInboxMessage) {
  return message.source?.agent || message.source?.provider || ''
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
// 与 gateway MESSAGE_TTL_MS 对齐：无显式 expiresAt 的消息按 createdAt+30d 到期
const MESSAGE_TTL_MS = 30 * 24 * 3600 * 1000
// 与 gateway TRASH_TTL_MS 对齐：回收站 7 天后物理清除
const TRASH_TTL_MS = 7 * 24 * 3600 * 1000
function retainedUntil(message: AgentInboxMessage) {
  const base = Date.parse(message.expiresAt || '') || Date.parse(message.createdAt) + MESSAGE_TTL_MS
  return Number.isFinite(base) ? new Date(base) : null
}
function trashPurgedAt(message: AgentInboxMessage) {
  const base = Date.parse(message.deletedAt || '')
  return Number.isFinite(base) ? new Date(base + TRASH_TTL_MS) : null
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
  const rootRef = useRef<HTMLDivElement>(null)
  // 桌面模式是近全屏 scrim 模态：登记按键层，Esc/Enter 不穿透到终端
  useModalLayer({ open: mode === 'desktop', getEl: () => rootRef.current, onEscape: onClose })
  const { t } = useTranslation()
  const messages = useInboxStore((state) => state.messages)
  const unreadCount = useInboxStore((state) => state.unreadCount)
  const deviceId = useInboxStore((state) => state.deviceId)
  const nextCursor = useInboxStore((state) => state.nextCursor)
  const listLoaded = useInboxStore((state) => state.listLoaded)
  const tabs = useInboxStore((state) => state.tabs)
  const activeTabId = useInboxStore((state) => state.activeTabId)
  const filter = useInboxStore((state) => state.filter)
  const stats = useInboxStore((state) => state.stats)
  const pendingSync = useInboxStore((state) => state.pendingSync)
  const syncError = useInboxStore((state) => state.syncError)
  const openTab = useInboxStore((state) => state.openTab)
  const closeTab = useInboxStore((state) => state.closeTab)
  const closeAllTabs = useInboxStore((state) => state.closeAllTabs)
  const setActiveTab = useInboxStore((state) => state.setActiveTab)
  const togglePinTab = useInboxStore((state) => state.togglePinTab)
  const setFilter = useInboxStore((state) => state.setFilter)
  const connectionStatus = useConsoleStore((state) => state.connection.status)
  const [forwardMessage, setForwardMessage] = useState<AgentInboxMessage | null>(null)
  const [shareMessage, setShareMessage] = useState<AgentInboxMessage | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [trashTargets, setTrashTargets] = useState<AgentInboxMessage[] | null>(null)
  const [purgeTargets, setPurgeTargets] = useState<AgentInboxMessage[] | null>(null)
  const [archiveIds, setArchiveIds] = useState<string[] | null>(null)
  const [confirmCloseTabs, setConfirmCloseTabs] = useState(false)

  // 打开面板即拉最新一页（WS 事件只带增量 metadata，首次/断线靠 REST 补齐）
  useEffect(() => {
    void refreshInboxList().catch(() => {})
  }, [])

  // 来源下拉选项从镜像现值收集：agent/provider 名与路由标签混排去重
  const sourceOptions = useMemo(() => {
    const values = new Set<string>()
    for (const message of messages) {
      const source = sourceKey(message)
      const route = routeLabel(message)
      if (source) values.add(source)
      if (route) values.add(route)
    }
    return [...values].sort()
  }, [messages])

  const filtered = useMemo(() => {
    const cutoff = filter.range === 'all' ? 0 : Date.now() - RANGE_MS[filter.range]
    return messages.filter((message) => {
      // 三视图互斥：回收站看软删，归档看非软删的归档，活动两者都排除
      if (filter.view === 'trash') {
        if (!message.deletedAt) return false
      } else if (filter.view === 'archived') {
        if (!message.archivedAt || message.deletedAt) return false
      } else if (message.archivedAt || message.deletedAt) return false
      const unread = isInboxUnread(message, deviceId)
      if (filter.status === 'unread' && !unread) return false
      if (filter.status === 'read' && unread) return false
      if (filter.type !== 'all' && message.type !== filter.type) return false
      if (filter.source && sourceKey(message) !== filter.source && routeLabel(message) !== filter.source) return false
      if (cutoff && Date.parse(message.createdAt) < cutoff) return false
      if (filter.query.trim() && !matchesQuery(message, filter.query.trim())) return false
      return true
    })
  }, [messages, filter, deviceId])
  // 删除/淘汰同步后清理选区，避免对已消失 id 发起批量操作
  const filteredIds = useMemo(() => new Set(filtered.map((message) => message.id)), [filtered])
  const selectedIds = useMemo(() => [...selected].filter((id) => filteredIds.has(id)), [selected, filteredIds])

  const openMessage = (message: AgentInboxMessage) => {
    openTab(message)
    markInboxRead([message.id])
    if (mode === 'mobile') onPreview?.(message)
  }
  const markAllRead = () => {
    const ids = messages.filter((item) => isInboxUnread(item, deviceId) && !item.deletedAt).map((item) => item.id)
    if (ids.length) markInboxRead(ids)
  }
  // 「归档已读」= 活动列表里已读的非回收站消息；与关闭 tab 完全无关
  const archivableIds = useMemo(
    () => messages.filter((item) => isInboxArchivable(item, deviceId)).map((item) => item.id),
    [messages, deviceId],
  )
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // 全选的作用域是「当前筛选结果」而非全历史——翻页未加载的条目不在内
  const toggleSelectAll = () =>
    setSelected(filteredIds.size && selectedIds.length === filteredIds.size ? new Set() : new Set(filteredIds))

  // 同步指示：pendingSync>0 时在途写/对账；断线叠加 pending 单独标待同步
  const syncState = syncError
    ? 'error'
    : pendingSync > 0
      ? connectionStatus === 'connected'
        ? 'syncing'
        : 'pending'
      : connectionStatus === 'connected'
        ? 'synced'
        : 'reconnecting'
  const SYNC_TONE = {
    synced: 'text-accent-2',
    syncing: 'text-accent',
    pending: 'text-warning',
    reconnecting: 'text-warning',
    error: 'text-danger',
  } as const
  const SYNC_LABEL_KEYS = {
    synced: 'inbox.syncSynced',
    syncing: 'inbox.syncSyncing',
    pending: 'inbox.syncPending',
    reconnecting: 'inbox.syncReconnecting',
    error: 'inbox.syncError',
  } as const

  const rowAction = (label: string, Icon: typeof FiCheck, onClick: () => void, hoverClass = 'hover:text-accent') => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm shrink-0 text-text-3 ${hoverClass}`}
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
        const unread = !!deviceId && isInboxUnread(message, deviceId)
        const title = inboxMessageTitle(message) || message.id
        const source = sourceKey(message)
        const route = routeLabel(message)
        const inTrash = filter.view === 'trash'
        const until = inTrash ? trashPurgedAt(message) : retainedUntil(message)
        const untilTitle = inTrash
          ? until
            ? t('inbox.trashPurgesAt', { date: until.toLocaleDateString() })
            : undefined
          : until
            ? t('inbox.retainedUntil', { date: until.toLocaleDateString() })
            : undefined
        return (
          <div
            key={message.id}
            className={`group flex items-center gap-1 rounded-apple border px-1.5 py-1 ${
              unread ? 'border-accent/40 bg-accent/5' : 'border-transparent'
            } ${activeTabId === message.id && mode === 'desktop' ? 'bg-accent/10' : 'hover:bg-bg-2'} ${
              selected.has(message.id) ? 'border-accent/60' : ''
            } ${mode === 'mobile' ? 'mb-0.5 min-h-11' : 'mb-0.5'}`}
          >
            <input
              type="checkbox"
              aria-label={t('inbox.selectMessage')}
              checked={selected.has(message.id)}
              onChange={() => toggleSelect(message.id)}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[rgb(var(--accent))]"
            />
            <button
              type="button"
              onClick={() => openMessage(message)}
              className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-left"
            >
              {/* 第一行：类型/未读/标题 + 时间；第二行：附件/来源/路由紧凑 meta */}
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon aria-hidden="true" className="shrink-0 text-text-3" size={13} />
                {unread && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label={t('inbox.unreadDot')} />
                )}
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-medium text-text-1' : 'text-text-2'}`}
                >
                  {title}
                </span>
                <span className="shrink-0 text-caption text-text-3/70" title={untilTitle}>
                  {formatTime(message.createdAt)}
                </span>
              </span>
              {(message.assetId || source || route) && (
                <span className="flex min-w-0 items-center gap-1.5 pl-5 text-caption text-text-3">
                  {message.assetId && (
                    <span className="flex min-w-0 shrink items-center gap-0.5" title={message.name}>
                      <FiPaperclip aria-hidden="true" className="shrink-0" size={11} />
                      <span className="min-w-0 truncate">{message.name || ''}</span>
                      <span className="shrink-0">{formatBytes(message.size)}</span>
                    </span>
                  )}
                  {source && <span className="min-w-0 max-w-28 truncate">·{source}</span>}
                  {route && <span className="min-w-0 max-w-32 truncate text-text-3/70">·{route}</span>}
                </span>
              )}
            </button>
            {/* 操作列定宽右对齐：图标带 tooltip，不挤压标题；移动端操作少列宽减半 */}
            <div
              className={`flex shrink-0 items-center justify-end gap-0.5 ${mode === 'desktop' ? 'w-[176px]' : 'w-[118px]'}`}
            >
              {message.assetId && rowAction(t('inbox.download'), FiDownload, () => void downloadAsset(message))}
              {(message.assetId || message.type === 'text' || message.type === 'link') &&
                mode === 'desktop' &&
                !inTrash &&
                rowAction(t('inbox.forward'), FiCornerUpRight, () => setForwardMessage(message), 'hover:text-text-1')}
              {mode === 'desktop' &&
                !inTrash &&
                rowAction(t('inbox.share'), FiShare2, () => setShareMessage(message), 'hover:text-text-1')}
              {canJump(message) && onJump && rowAction(t('inbox.jump'), FiExternalLink, () => onJump(message))}
              {inTrash ? (
                <>
                  {rowAction(t('inbox.restore'), FiRotateCcw, () => restoreInboxMessages([message.id]))}
                  {rowAction(t('inbox.purge'), FiTrash2, () => setPurgeTargets([message]), 'hover:text-danger')}
                </>
              ) : filter.view === 'archived' ? (
                <>
                  {rowAction(t('inbox.restore'), FiRotateCcw, () => archiveInboxMessages([message.id], false))}
                  {rowAction(t('inbox.delete'), FiTrash2, () => setTrashTargets([message]), 'hover:text-danger')}
                </>
              ) : (
                <>
                  {unread
                    ? rowAction(t('inbox.markRead'), FiCheck, () => markInboxRead([message.id]), 'hover:text-accent-2')
                    : rowAction(
                        t('inbox.markUnread'),
                        FiMail,
                        () => markInboxRead([message.id], false),
                        'hover:text-accent-2',
                      )}
                  {rowAction(t('inbox.delete'), FiTrash2, () => setTrashTargets([message]), 'hover:text-danger')}
                </>
              )}
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
        {/* 同步状态：乐观写/对账在途、断线、失败都显式提示，不假装已同步 */}
        <span className={`flex shrink-0 items-center gap-1 text-caption ${SYNC_TONE[syncState]}`}>
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${syncState === 'syncing' ? 'animate-pulse' : ''}`} />
          {t(SYNC_LABEL_KEYS[syncState])}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {filter.view === 'active' && unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              {t('inbox.markAllRead')}
            </Button>
          )}
          {filter.view === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!archivableIds.length}
              title={archivableIds.length ? t('inbox.archiveReadHint') : t('inbox.noReadToArchive')}
              onClick={() => archivableIds.length && setArchiveIds(archivableIds)}
            >
              {t('inbox.archiveRead')}
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
      <div className="flex h-9 flex-wrap items-center gap-1.5 px-2 pb-1.5">
        <input
          type="checkbox"
          aria-label={t('inbox.selectAll')}
          title={t('inbox.selectAllScope')}
          checked={filteredIds.size > 0 && selectedIds.length === filteredIds.size}
          onChange={toggleSelectAll}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[rgb(var(--accent))]"
        />
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
          value={filter.view}
          onChange={(value) => {
            setFilter({ view: value as InboxViewFilter })
            setSelected(new Set())
          }}
          variant="inline"
          options={VIEW_OPTIONS.map((view) => ({ value: view, label: t(VIEW_LABEL_KEYS[view]) }))}
          aria-label={t('inbox.viewActive')}
        />
        <Select
          value={filter.status}
          onChange={(value) => setFilter({ status: value as InboxStatusFilter })}
          variant="inline"
          options={STATUS_OPTIONS.map((status) => ({ value: status, label: t(STATUS_LABEL_KEYS[status]) }))}
          aria-label={t('inbox.statusAll')}
        />
        <Select
          value={filter.type}
          onChange={(value) => setFilter({ type: value as InboxFilter['type'] })}
          variant="inline"
          options={FILTER_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL_KEYS[type]) }))}
          aria-label={t('inbox.typeAll')}
        />
        {sourceOptions.length > 0 && (
          <Select
            value={filter.source || ''}
            onChange={(value) => setFilter({ source: value })}
            variant="inline"
            options={[
              { value: '', label: t('inbox.sourceAll') },
              ...sourceOptions.map((source) => ({ value: source, label: source })),
            ]}
            aria-label={t('inbox.sourceAll')}
          />
        )}
        <Select
          value={filter.range}
          onChange={(value) => setFilter({ range: value as InboxRangeFilter })}
          variant="inline"
          options={RANGE_OPTIONS.map((range) => ({ value: range, label: t(RANGE_LABEL_KEYS[range]) }))}
          aria-label={t('inbox.rangeAll')}
        />
        <span className="shrink-0 text-caption text-text-3/70">
          {t('inbox.count', { shown: filtered.length, total: messages.length })}
        </span>
        {/* 容量口径来自服务端 stats：消息数按非回收站计，asset 含回收站引用 */}
        {stats && (
          <span
            className={`shrink-0 text-caption ${
              stats.messages >= stats.maxMessages * 0.85 || stats.assetBytes >= stats.maxAssetBytes * 0.85
                ? 'text-warning'
                : 'text-text-3/70'
            }`}
            title={t('inbox.capacityHint')}
          >
            {stats.messages}/{stats.maxMessages} · {formatBytes(stats.assetBytes)}/{formatBytes(stats.maxAssetBytes)}
          </span>
        )}
      </div>
      {/* 选中态批量条：操作随视图切换；全选范围=当前筛选结果 */}
      {selectedIds.length > 0 && (
        <div className="flex h-8 items-center gap-1.5 border-t border-[var(--line)] px-2 text-xs text-text-3">
          <span className="text-accent">{t('inbox.selected', { n: selectedIds.length })}</span>
          <div className="ml-auto flex items-center gap-1">
            {filter.view === 'trash' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    restoreInboxMessages(selectedIds)
                    setSelected(new Set())
                  }}
                >
                  {t('inbox.restoreSelected')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setPurgeTargets(filtered.filter((message) => selected.has(message.id)))}
                >
                  {t('inbox.purgeSelected')}
                </Button>
              </>
            ) : filter.view === 'archived' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    archiveInboxMessages(selectedIds, false)
                    setSelected(new Set())
                  }}
                >
                  {t('inbox.restoreSelected')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setTrashTargets(filtered.filter((message) => selected.has(message.id)))}
                >
                  {t('inbox.deleteSelected')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    markInboxRead(selectedIds)
                    setSelected(new Set())
                  }}
                >
                  {t('inbox.markSelectedRead')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    markInboxRead(selectedIds, false)
                    setSelected(new Set())
                  }}
                >
                  {t('inbox.markSelectedUnread')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!selectedIds.some((id) => archivableIds.includes(id))}
                  title={t('inbox.archiveSelectedHint')}
                  onClick={() => {
                    const read = selectedIds.filter((id) => archivableIds.includes(id))
                    if (read.length) archiveInboxMessages(read, true)
                    setSelected(new Set())
                  }}
                >
                  {t('inbox.archiveSelected')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setTrashTargets(filtered.filter((message) => selected.has(message.id)))}
                >
                  {t('inbox.deleteSelected')}
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  // 删除=进回收站（软删）：确认文案明说可恢复窗口，不是永久消失
  const confirmTrash = (
    <ConfirmDialog
      open={!!trashTargets}
      title={t('inbox.delete')}
      message={
        trashTargets && trashTargets.length > 1
          ? t('inbox.confirmTrashMany', { n: trashTargets.length })
          : t('inbox.confirmTrash')
      }
      confirmLabel={t('inbox.delete')}
      cancelLabel={t('common.cancel')}
      tone="danger"
      items={trashTargets?.map((message) => inboxMessageTitle(message) || message.id)}
      onConfirm={() => {
        if (trashTargets?.length) deleteInboxMessages(trashTargets.map((message) => message.id))
        setTrashTargets(null)
        setSelected(new Set())
      }}
      onCancel={() => setTrashTargets(null)}
    />
  )

  // purge 才是物理删除：只在回收站视图出现，文案必须说清不可恢复
  const confirmPurge = (
    <ConfirmDialog
      open={!!purgeTargets}
      title={t('inbox.purge')}
      message={
        purgeTargets && purgeTargets.length > 1
          ? t('inbox.confirmPurgeMany', { n: purgeTargets.length })
          : t('inbox.confirmPurge')
      }
      confirmLabel={t('inbox.purge')}
      cancelLabel={t('common.cancel')}
      tone="danger"
      items={purgeTargets?.map((message) => inboxMessageTitle(message) || message.id)}
      onConfirm={() => {
        if (purgeTargets?.length) purgeInboxMessages(purgeTargets.map((message) => message.id))
        setPurgeTargets(null)
        setSelected(new Set())
      }}
      onCancel={() => setPurgeTargets(null)}
    />
  )

  // 归档已读：历史保留可查（archived 视图），语气中性（≠ 删除 ≠ 关 tab）
  const confirmArchive = (
    <ConfirmDialog
      open={!!archiveIds}
      title={t('inbox.archiveRead')}
      message={t('inbox.confirmArchiveRead', { n: archiveIds?.length || 0 })}
      confirmLabel={t('inbox.archiveRead')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => {
        if (archiveIds?.length) archiveInboxMessages(archiveIds, true)
        setArchiveIds(null)
        setSelected(new Set())
      }}
      onCancel={() => setArchiveIds(null)}
    />
  )

  // 关闭全部已打开 = 只清右侧预览 tab：纯本地 UI 态，不动消息/已读/归档，
  // 不发任何服务端事件——确认框报 tab 数以示范围
  const confirmCloseAllTabs = (
    <ConfirmDialog
      open={confirmCloseTabs}
      title={t('inbox.closeAllTabs')}
      message={t('inbox.confirmCloseAllTabs', { n: tabs.length })}
      confirmLabel={t('inbox.closeAllTabs')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => {
        closeAllTabs()
        setConfirmCloseTabs(false)
      }}
      onCancel={() => setConfirmCloseTabs(false)}
    />
  )

  const dialogs = (
    <>
      {forwardMessage && <InboxForwardDialog message={forwardMessage} onClose={() => setForwardMessage(null)} />}
      {shareMessage && <InboxShareDialog message={shareMessage} onClose={() => setShareMessage(null)} />}
      {confirmTrash}
      {confirmPurge}
      {confirmArchive}
      {confirmCloseAllTabs}
    </>
  )

  if (mode === 'mobile') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        {header}
        {list}
        {dialogs}
      </div>
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex items-center justify-center tmuxgo-scrim p-4"
      onMouseDown={onClose}
    >
      {/* 桌面端接近全屏：92vw/92dvh，上限 1440x960；左栏 clamp 420-520px */}
      <section
        className="tmuxgo-glass tmuxgo-glass-dialog flex h-[min(92dvh,960px)] w-[min(92vw,1440px)] flex-col overflow-hidden rounded-apple border sm:flex-row"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-44 w-full shrink-0 flex-col border-b border-[var(--line)] bg-bg-1 sm:h-auto sm:w-[clamp(420px,34%,520px)] sm:border-b-0 sm:border-r">
          {header}
          {list}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 右侧 tab 标题栏常驻：无 tab 时也要露出「关闭全部」（禁用态） */}
          <div className="flex h-9 shrink-0 items-end gap-1 border-b border-[var(--line)] px-2">
            <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto scrollbar-none">
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
            {/* 关闭全部已打开=清右侧 tab 集合：只动 UI 态，不归档/删除/改已读 */}
            <button
              type="button"
              aria-label={t('inbox.closeAllTabs')}
              title={tabs.length ? t('inbox.closeAllTabsHint') : t('inbox.noOpenTabs')}
              disabled={!tabs.length}
              onClick={() => tabs.length && setConfirmCloseTabs(true)}
              className="mb-1 flex shrink-0 items-center gap-1 rounded-apple px-1.5 py-0.5 text-caption text-text-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FiX aria-hidden="true" size={12} />
              {t('inbox.closeAllTabs')}
              {tabs.length > 0 && <span className="text-text-3/70">({tabs.length})</span>}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {activeTab ? (
              <InboxPreview messageId={activeTab.messageId} onJump={onJump} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-text-3">
                <FiInbox aria-hidden="true" size={28} />
                <span className="text-sm">{t('inbox.noPreview')}</span>
              </div>
            )}
          </div>
        </div>
      </section>
      {dialogs}
    </div>
  )
}
