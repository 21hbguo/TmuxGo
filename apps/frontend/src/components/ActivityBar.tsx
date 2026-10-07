'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useInboxStore } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import { FiBell, FiFolder, FiGitBranch, FiInbox, FiServer, FiSettings } from 'react-icons/fi'
import {
  FiActivity,
  FiBox,
  FiCode,
  FiCompass,
  FiCpu,
  FiCrosshair,
  FiDatabase,
  FiGlobe,
  FiMonitor,
  FiShare2,
  FiTerminal,
  FiTool,
  FiZap,
} from 'react-icons/fi'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Fragment, useState } from 'react'
import { usePlugins } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'
import { useElementPickerStore } from '@/stores/useElementPickerStore'
import { ModalPortal } from './ModalPortal'

const pluginIcons = {
  activity: FiActivity,
  box: FiBox,
  code: FiCode,
  cpu: FiCpu,
  database: FiDatabase,
  globe: FiGlobe,
  terminal: FiTerminal,
  tool: FiTool,
  zap: FiZap,
}

type ActivityItem = {
  id: string
  label: string
  title?: string
  icon: typeof FiServer
  onClick: () => void
  active: boolean
  unread: number
  plugin: boolean
}

// 已存序优先、未知 id 剔除、新项（如后来启用的插件视图）按自然序补尾
export function orderActivityItems<T extends { id: string }>(items: T[], order?: string[]) {
  if (!order?.length) return items
  const byId = new Map(items.map((item) => [item.id, item]))
  const used = new Set<string>()
  const ordered: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (!item || used.has(id)) continue
    used.add(id)
    ordered.push(item)
  }
  for (const item of items) if (!used.has(item.id)) ordered.push(item)
  return ordered
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function ActivityIconBody({ item }: { item: ActivityItem }) {
  const Icon = item.icon
  return (
    <span className="relative">
      <Icon aria-hidden="true" size={18} />
      {item.unread > 0 && (
        <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-danger px-0.5 text-center text-[9px] font-medium leading-4 text-white">
          {item.unread > 99 ? '99+' : item.unread}
        </span>
      )}
    </span>
  )
}

function ActivityButton({ item }: { item: ActivityItem }) {
  return (
    <button
      aria-label={item.label}
      title={item.title ?? item.label}
      onClick={item.onClick}
      className={`tmuxgo-toolbar-icon ${item.active ? 'tmuxgo-toolbar-icon--active' : ''}`}
    >
      <ActivityIconBody item={item} />
    </button>
  )
}

// 与 SessionSortableList 同一套交互：wrapper 挂 listeners，内部 button 保持 onClick；
// MouseSensor distance=6 阈值保证普通点击不会被当成拖拽
function SortableActivityItem({ item }: { item: ActivityItem }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`touch-pan-y select-none cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
    >
      <ActivityButton item={item} />
    </div>
  )
}

export function ActivityBar() {
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const toggleSshPanel = useConsoleStore((state) => state.toggleSshPanel)
  const sshPanelOpen = useConsoleStore((state) => state.sshPanelOpen)
  const endpointsPanelOpen = useConsoleStore((state) => state.endpointsPanelOpen)
  const toggleEndpointsPanel = useConsoleStore((state) => state.toggleEndpointsPanel)
  const activePluginView = useConsoleStore((state) => state.activePluginView)
  const setActivePluginView = useConsoleStore((state) => state.setActivePluginView)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeDesktop = useConsoleStore((state) => state.activeDesktop)
  const toggleDesktop = useConsoleStore((state) => state.toggleDesktop)
  const activeBrowser = useConsoleStore((state) => state.activeBrowser)
  const toggleBrowser = useConsoleStore((state) => state.toggleBrowser)
  const toggleGitPanel = useConsoleStore((state) => state.toggleGitPanel)
  const pickerActive = useElementPickerStore((state) => state.active)
  const togglePicker = useElementPickerStore((state) => state.toggle)
  const inboxPanelOpen = useInboxStore((state) => state.panelOpen)
  const inboxUnread = useInboxStore((state) => state.unreadCount)
  const { t } = useTranslation()
  const { data } = usePlugins()
  const { preferences, updatePreferences } = usePreferences()
  const pluginViews = (data?.plugins || [])
    .filter((plugin) => plugin.enabled && plugin.state === 'active')
    .flatMap((plugin) => (plugin.manifest.contributes?.views || []).map((view) => ({ plugin, view })))
  const items: ActivityItem[] = [
    {
      id: 'sessions',
      label: t('activity.sessions'),
      icon: FiServer,
      onClick: toggleSessionPanel,
      active: sessionPanelExpanded,
      unread: 0,
      plugin: false,
    },
    {
      id: 'ssh',
      label: t('activity.ssh'),
      icon: FiGlobe,
      onClick: toggleSshPanel,
      active: sshPanelOpen,
      unread: 0,
      plugin: false,
    },
    {
      id: 'endpoints',
      label: t('endpoints.title'),
      icon: FiShare2,
      onClick: toggleEndpointsPanel,
      active: endpointsPanelOpen,
      unread: 0,
      plugin: false,
    },
    {
      id: 'files',
      label: t('activity.explorer'),
      icon: FiFolder,
      onClick: toggleFilePanel,
      active: filePanelOpen,
      unread: 0,
      plugin: false,
    },
    {
      id: 'git',
      label: t('git.title'),
      icon: FiGitBranch,
      onClick: toggleGitPanel,
      active: gitPanelOpen,
      unread: 0,
      plugin: false,
    },
    {
      id: 'desktop',
      label: t('vnc.title'),
      icon: FiMonitor,
      onClick: () => toggleDesktop(activeHostId || 'local'),
      active: !!activeDesktop,
      unread: 0,
      plugin: false,
    },
    {
      id: 'browser',
      label: t('browser.title'),
      icon: FiCompass,
      onClick: () => toggleBrowser(activeHostId || 'local'),
      active: !!activeBrowser,
      unread: 0,
      plugin: false,
    },
    {
      id: 'inbox',
      label: t('inbox.title'),
      icon: FiInbox,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-inbox')),
      active: inboxPanelOpen,
      unread: inboxUnread,
      plugin: false,
    },
    {
      id: 'notifications',
      label: t('notification.title'),
      icon: FiBell,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')),
      active: false,
      unread: 0,
      plugin: false,
    },
    {
      id: 'picker',
      label: t('picker.title'),
      icon: FiCrosshair,
      onClick: togglePicker,
      active: pickerActive,
      unread: 0,
      plugin: false,
    },
    {
      id: 'settings',
      label: t('activity.settings'),
      icon: FiSettings,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')),
      active: false,
      unread: 0,
      plugin: false,
    },
    // 插件视图并入同一排序序列：id 前缀 plugin: 与固定项区分
    ...pluginViews.map(({ plugin, view }): ActivityItem => {
      const Icon = pluginIcons[(view.icon || plugin.manifest.icon || 'box') as keyof typeof pluginIcons] || FiBox
      return {
        id: `plugin:${plugin.pluginId}:${view.id}`,
        label: view.title,
        title: `${view.title} · ${plugin.manifest.name}`,
        icon: Icon,
        onClick: () => setActivePluginView({ pluginId: plugin.pluginId, viewId: view.id }),
        active: activePluginView?.pluginId === plugin.pluginId && activePluginView.viewId === view.id,
        unread: 0,
        plugin: true,
      }
    }),
  ]
  // savedIds = 已存序作用于当前项集后的完整 id 序；拖拽期间以 previewIds 顶替做实时预览
  const savedIds = orderActivityItems(items, preferences.activityBarOrder).map((item) => item.id)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [previewIds, setPreviewIds] = useState<string[]>([])
  const displayIds = activeId ? previewIds : savedIds
  const orderedItems = orderActivityItems(items, displayIds)
  const activeItem = items.find((item) => item.id === activeId) || null
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id))
    setPreviewIds(displayIds)
  }
  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id ? String(event.over.id) : null
    const draggedId = event.active?.id ? String(event.active.id) : null
    if (!overId || !draggedId || overId === draggedId) return
    setPreviewIds((current) => {
      const from = current.indexOf(draggedId)
      const to = current.indexOf(overId)
      if (from === -1 || to === -1 || from === to) return current
      return arrayMove(current, from, to)
    })
  }
  const resetDrag = () => {
    setActiveId(null)
    setPreviewIds([])
  }
  const handleDragEnd = (_event: DragEndEvent) => {
    // 落点序 = 全量 id 快照（含未拖动的项），经 uiPreferences 落到 gateway 跨端同步
    const next = previewIds
    resetDrag()
    if (next.length && !arraysEqual(next, savedIds)) updatePreferences({ activityBarOrder: next })
  }
  return (
    <aside className="tmuxgo-glass tmuxgo-glass-sidebar flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--line)] py-3 overflow-hidden scrollbar-none">
      <img src="/app-icon.svg" alt="" className="mb-1 h-9 w-9" />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={resetDrag}
      >
        <SortableContext items={displayIds} strategy={verticalListSortingStrategy}>
          {orderedItems.map((item, index) => (
            <Fragment key={item.id}>
              {/* 首个插件项之前画分隔线：插件被拖进固定项中间时跟随移动 */}
              {item.plugin && index > 0 && !orderedItems[index - 1].plugin && (
                <div className="my-1 h-px w-7 shrink-0 bg-[var(--line)]" />
              )}
              <SortableActivityItem item={item} />
            </Fragment>
          ))}
        </SortableContext>
        {/* DragOverlay 必须 portal 出容器：aside 的 backdrop-filter 会成为
            fixed 后代包含块，top 按侧栏坐标而非视口解析导致拖拽投影错位 */}
        <ModalPortal>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
            {activeItem ? (
              <div className={`tmuxgo-toolbar-icon ${activeItem.active ? 'tmuxgo-toolbar-icon--active' : ''}`}>
                <ActivityIconBody item={activeItem} />
              </div>
            ) : null}
          </DragOverlay>
        </ModalPortal>
      </DndContext>
    </aside>
  )
}
