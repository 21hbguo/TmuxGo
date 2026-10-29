'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import {
  useBatchDeleteSessions,
  useCreateSession,
  useDeleteSession,
  useRenameSession,
  useSessionTemplates,
} from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import {
  useSessionWorkspaces,
  useSetSessionWorkspace,
  useRemoveSessionWorkspaces,
  useMigrateSessionWorkspace,
} from '@/hooks/useSessionWorkspaces'
import { useCreateWorkspace, useRemoveWorkspace, useUpdateWorkspace, useWorkspaces } from '@/hooks/useWorkspaces'
import { useSplitGroups } from '@/hooks/useSplitGroups'
import { SessionTemplates, templates as builtinTemplates, type Template } from './SessionTemplates'
import { SessionLayoutImportDialog } from './SessionLayoutImportDialog'
import { CreateSessionDialog } from './CreateSessionDialog'
import { SessionHoverCard } from './SessionHoverCard'
import { getDefaultSessionName } from '@/lib/session-template'
import { parseSessionName } from '@/lib/session-id'
import { requestTerminalFocus } from '@/lib/terminal-focus-request'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { QuickActions } from './QuickActions'
import { usePreferences, type SessionSortMode } from '@/hooks/usePreferences'
import { useTranslation, type TranslationKey } from '@/i18n'
import { usePrompt } from '@/hooks/usePrompt'
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
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import {
  SessionGroupedSortableList,
  SessionSortableList,
  findPreviewGroup,
  movePreviewBetweenGroups,
  orderByIds,
  type GetClassNameArgs,
  type RenderSessionArgs,
} from './SessionSortableList'
import { HostSwitcher } from './HostSwitcher'
import { AgentStatusBadge } from './AgentStatusBadge'
import { getAgentAttentionRank, mergeAgentSummaries } from '@/lib/agent-status'
import type { AgentStatus, AgentSummary, Pane, Session, SessionSnapshot, WorkspaceEntry } from '@/types'
import { ModalPortal } from './ModalPortal'
import { api } from '@/lib/api'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { WorkspaceDirectoryPicker, type WorkspaceDirectoryTarget } from './WorkspaceDirectoryPicker'
import {
  FiChevronsDown,
  FiCheck,
  FiChevronDown,
  FiCommand,
  FiDownload,
  FiFolder,
  FiFolderPlus,
  FiLayers,
  FiMoreHorizontal,
  FiPlus,
  FiUpload,
} from 'react-icons/fi'

function getNextSessionId(sessions: { id: string }[], removedIds: string[]) {
  const removed = new Set(removedIds)
  return sessions.find((item) => !removed.has(item.id))?.id || ''
}

type SessionGroup = { key: string; workspace: WorkspaceEntry | null; sessions: Session[]; agentSummary: AgentSummary }
// 单一事实表：菜单顺序与 label key 同源，漏登 label 类型层即报
const SESSION_SORTS: { rule: SessionSortMode; labelKey: TranslationKey }[] = [
  { rule: 'manual', labelKey: 'sidebar.sortManual' },
  { rule: 'createdAt', labelKey: 'sidebar.sortCreatedAt' },
  { rule: 'lastActiveAt', labelKey: 'sidebar.sortLastActiveAt' },
  { rule: 'name', labelKey: 'sidebar.sortName' },
  { rule: 'attention', labelKey: 'sidebar.sortAttention' },
]
const SESSION_SORT_RULES: SessionSortMode[] = SESSION_SORTS.map((item) => item.rule)
const SESSION_SORT_LABELS = Object.fromEntries(SESSION_SORTS.map((item) => [item.rule, item.labelKey])) as Record<
  SessionSortMode,
  TranslationKey
>
// 禁用拖拽时给 DndContext 的固定空表：字面量 [] 每次 render 都是新引用，会导致传感器反复拆装
const NO_SENSORS: never[] = []
const sameIdOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])
const timeValue = (value?: string) => {
  const ms = Date.parse(value || '')
  return Number.isNaN(ms) ? 0 : ms
}
// 会话级排序：时间类新→旧，name 走 localeCompare，attention 用现成 rank；
// 返回 0 时依赖 Array.sort 稳定性保住用户手动序
function compareSessionsByRule(rule: SessionSortMode, a: Session, b: Session) {
  switch (rule) {
    case 'createdAt':
      return timeValue(b.createdAt) - timeValue(a.createdAt)
    case 'lastActiveAt':
      return timeValue(b.lastActiveAt) - timeValue(a.lastActiveAt)
    case 'name':
      // numeric: session-2 应排在 session-10 前
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    case 'attention':
      return getAgentAttentionRank(a.agentSummary) - getAgentAttentionRank(b.agentSummary)
    default:
      return 0
  }
}
// 组间聚合值：lastActiveAt 取组内最大值、createdAt 取组内最新 session、
// name 用 workspace.name、attention 用组 rollup 的 rank；「未分类」恒沉底
function compareGroupsByRule(rule: SessionSortMode, a: SessionGroup, b: SessionGroup) {
  if (!a.workspace && !b.workspace) return 0
  if (!a.workspace) return 1
  if (!b.workspace) return -1
  // 空组没有任何可聚合信号，按任何规则排都突兀：统一沉底（未分类之上语义不变）
  if (!a.sessions.length || !b.sessions.length) {
    if (a.sessions.length === b.sessions.length) return 0
    return a.sessions.length ? -1 : 1
  }
  switch (rule) {
    case 'createdAt':
      return maxTime(b.sessions, 'createdAt') - maxTime(a.sessions, 'createdAt')
    case 'lastActiveAt':
      return maxTime(b.sessions, 'lastActiveAt') - maxTime(a.sessions, 'lastActiveAt')
    case 'name':
      return a.workspace.name.localeCompare(b.workspace.name, undefined, { numeric: true })
    case 'attention':
      return getAgentAttentionRank(a.agentSummary) - getAgentAttentionRank(b.agentSummary)
    default:
      return 0
  }
}
function maxTime(sessions: Session[], field: 'createdAt' | 'lastActiveAt') {
  return sessions.reduce((max, session) => Math.max(max, timeValue(session[field])), 0)
}

export function SessionPanel() {
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setActivePane = useConsoleStore((state) => state.setActivePane)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const queryClient = useOptionalQueryClient()
  const { data: sessions = [], moveSession, isError, error, refetch } = useOrderedSessions(activeHostId || '')
  const createSession = useCreateSession()
  const deleteSession = useDeleteSession()
  const batchDeleteSessions = useBatchDeleteSessions()
  const renameSession = useRenameSession()
  const setSessionWorkspace = useSetSessionWorkspace()
  const removeSessionWorkspaces = useRemoveSessionWorkspaces()
  const { groups: splitGroups, remove: removeSplitGroup } = useSplitGroups()
  const splitGroupsRef = useRef(splitGroups)
  useEffect(() => {
    splitGroupsRef.current = splitGroups
  }, [splitGroups])
  const migrateSessionWorkspace = useMigrateSessionWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const removeWorkspace = useRemoveWorkspace()
  const { data: sessionWorkspaces = [] } = useSessionWorkspaces()
  const { data: workspaces = [] } = useWorkspaces(activeHostId || undefined)
  const createWorkspace = useCreateWorkspace()
  const { data: sessionTemplates } = useSessionTemplates()
  const [createDialogInitialWorkspace, setCreateDialogInitialWorkspace] = useState<WorkspaceEntry | null>(null)
  const [createDialogCwd, setCreateDialogCwd] = useState<string | null>(null)
  const [createDialogWorktreeLink, setCreateDialogWorktreeLink] = useState<{
    repoPath: string
    worktreePath: string
  } | null>(null)
  const [templateWorkspace, setTemplateWorkspace] = useState<WorkspaceEntry | null>(null)
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceEntry | null>(null)
  const [templateMenu, setTemplateMenu] = useState<{ workspace: WorkspaceEntry; top: number; right: number } | null>(
    null,
  )
  // 菜单 portal 定位后不会跟随组头滚动：滚动即关；外部 mousedown 同样关闭
  useEffect(() => {
    if (!templateMenu) return
    const close = () => setTemplateMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [templateMenu])
  const [sortMenu, setSortMenu] = useState<{ top: number; right: number } | null>(null)
  // 与组头菜单同策略：portal + fixed 定位不跟随滚动，滚动/外部 mousedown 即关
  useEffect(() => {
    if (!sortMenu) return
    const close = () => setSortMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [sortMenu])
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const [showTemplates, setShowTemplates] = useState(false)
  const [showLayoutImport, setShowLayoutImport] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [createDialogTemplate, setCreateDialogTemplate] = useState<Template | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  // hover 预览卡：identity 与锚点分开——anchorRect 置 null 进宽限期时卡片仍要活着，
  // 等卡片宽限结束自行 close 再清 identity（见 SessionHoverCard 内部计时）
  const [hoverSession, setHoverSession] = useState<{ id: string; name: string } | null>(null)
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null)
  const handleTemplateSelect = (template: Template) => {
    if (!activeHostId) return
    setShowTemplates(false)
    setCreateDialogTemplate(template)
    setCreateDialogInitialWorkspace(templateWorkspace)
    setTemplateWorkspace(null)
    setCreateDialogOpen(true)
  }
  const refreshSessions = () => {
    void refetch()
  }
  const handleLayoutApplied = (session: Session) => {
    setShowLayoutImport(false)
    refreshSessions()
    if (session.id) {
      setActiveSession(session.id)
      requestTerminalFocus(activeHostId || 'local', parseSessionName(activeHostId || 'local', session.id))
    }
    pushToast({ type: 'success', message: t('session.layoutImported', { name: session.name }) })
  }
  const allTemplates = [...builtinTemplates, ...(sessionTemplates?.templates || [])]
  const handleWorkspaceCreateSession = (workspace: WorkspaceEntry) => {
    if (!activeHostId) return
    setWorkspaceMenuOpen(false)
    const template = workspace.templateId ? allTemplates.find((item) => item.id === workspace.templateId) : null
    if (template) {
      setCreateDialogTemplate(template)
      setCreateDialogInitialWorkspace(workspace)
      setCreateDialogOpen(true)
      return
    }
    setTemplateWorkspace(workspace)
    setShowTemplates(true)
  }
  const handleWorkspaceSetTemplate = async (workspace: WorkspaceEntry, templateId: string) => {
    setTemplateMenu(null)
    try {
      await updateWorkspace.mutateAsync({ id: workspace.id, payload: { templateId } })
      pushToast({ type: 'success', message: t('workspace.templateUpdated', { name: workspace.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('workspace.requestFailed') })
    }
  }
  const handleWorkspaceRename = async (workspace: WorkspaceEntry) => {
    if (!activeHostId) return
    const name = await prompt(t('workspace.renamePrompt'), workspace.name)
    if (!name || name === workspace.name) return
    try {
      await updateWorkspace.mutateAsync({ id: workspace.id, payload: { name: name.trim() } })
      pushToast({ type: 'success', message: t('workspace.renamed', { name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('workspace.requestFailed') })
    }
  }
  const confirmDeleteWorkspace = async () => {
    if (!pendingDeleteWorkspace) return
    const workspace = pendingDeleteWorkspace
    try {
      await removeWorkspace.mutateAsync(workspace.id)
      pushToast({ type: 'success', message: t('workspace.deleted', { name: workspace.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('workspace.requestFailed') })
    }
    setPendingDeleteWorkspace(null)
  }
  const handleCreateSession = async ({
    name,
    cwd,
    workspace,
  }: {
    name: string
    cwd?: string
    workspace?: {
      rootId: string
      rootPath: string
      rootLabel: string
      relativePath: string
      absolutePath: string
      workspaceId?: string
      workspaceName?: string
    }
  }) => {
    if (!activeHostId || !createDialogTemplate) return
    try {
      const created = await createSession.mutateAsync({
        hostId: activeHostId,
        name,
        layout: createDialogTemplate.layout,
        cwd,
      })
      if (created?.id) {
        if (cwd && workspace) {
          try {
            await setSessionWorkspace.mutateAsync({
              sessionId: created.id,
              hostId: activeHostId,
              workspaceId: workspace.workspaceId,
              workspacePath: workspace.absolutePath,
              rootId: workspace.rootId,
              rootPath: workspace.rootPath,
              rootLabel: workspace.rootLabel,
              relativePath: workspace.relativePath,
              updatedAt: new Date().toISOString(),
            })
          } catch {}
        }
        if (createDialogWorktreeLink) {
          // worktree → session 关联写回 provenance（失败不阻塞会话创建）
          try {
            await api.git.linkWorktree(
              activeHostId,
              createDialogWorktreeLink.repoPath,
              createDialogWorktreeLink.worktreePath,
              {
                sessionId: created.id,
                workspaceId: workspace?.workspaceId,
              },
            )
          } catch {}
        }
        setActiveSession(created.id)
        requestTerminalFocus(activeHostId, parseSessionName(activeHostId, created.id))
        pushToast({
          type: created.existed ? 'info' : 'success',
          message: t(created.existed ? 'session.alreadyExists' : 'session.created', { name }),
        })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
      throw err
    }
    setCreateDialogOpen(false)
    setCreateDialogTemplate(null)
  }
  // 导出为版本化 layout JSON 文件（gateway 端保证不含 env/输出/参数）
  const handleExportSessionLayout = async (session: Session) => {
    if (!activeHostId) return
    try {
      const doc = await api.sessions.exportLayout(activeHostId, session.id)
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${session.name}.layout.json`
      anchor.click()
      // 延后 revoke：click 同步触发下载，立即回收会让部分浏览器拿到失效 URL
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      pushToast({ type: 'success', message: t('session.layoutExported', { name: session.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
  }
  const confirmDeleteSession = async () => {
    if (!activeHostId || !pendingDeleteSessionId) return
    const session = sessions.find((item) => item.id === pendingDeleteSessionId)
    try {
      await deleteSession.mutateAsync({ hostId: activeHostId, sessionId: pendingDeleteSessionId })
      try {
        await removeSessionWorkspaces.mutateAsync([pendingDeleteSessionId])
      } catch {}
      splitGroupsRef.current
        .filter(
          (item) =>
            item.primarySessionId === pendingDeleteSessionId || item.secondarySessionId === pendingDeleteSessionId,
        )
        .forEach((item) => removeSplitGroup(item.id))
      if (activeSessionId === pendingDeleteSessionId)
        setActiveSession(getNextSessionId(sessions, [pendingDeleteSessionId]))
      pushToast({ type: 'success', message: t('session.deleted', { name: session?.name || pendingDeleteSessionId }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setPendingDeleteSessionId(null)
  }
  const confirmBatchDeleteSession = async () => {
    if (!activeHostId || !selectedSessionIds.length) return
    try {
      const preview = await batchDeleteSessions.mutateAsync({
        hostId: activeHostId,
        payload: { mode: 'preview', sessionIds: selectedSessionIds, filters: { includeAttached: true } },
      })
      const execute = await batchDeleteSessions.mutateAsync({
        hostId: activeHostId,
        payload: {
          mode: 'execute',
          sessionIds: selectedSessionIds,
          filters: { includeAttached: true },
          force: preview.forceRequired === true,
        },
      })
      const deletedIds = new Set((execute.deleted || []).map((item) => item.sessionId))
      const deletedCount = typeof execute.deletedCount === 'number' ? execute.deletedCount : deletedIds.size
      if (deletedIds.size) {
        try {
          await removeSessionWorkspaces.mutateAsync(Array.from(deletedIds))
        } catch {}
      }
      if (deletedIds.size)
        splitGroupsRef.current
          .filter((item) => deletedIds.has(item.primarySessionId) || deletedIds.has(item.secondarySessionId))
          .forEach((item) => removeSplitGroup(item.id))
      if (activeSessionId && deletedIds.has(activeSessionId))
        setActiveSession(getNextSessionId(sessions, Array.from(deletedIds)))
      pushToast({ type: 'success', message: t('sidebar.batchDeleteSuccess', { count: deletedCount }) })
      setSelectedSessionIds([])
      setBatchMode(false)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
    setBatchDeleteConfirmOpen(false)
  }
  const handleRenameSession = async (sessionId: string) => {
    if (!activeHostId) return
    const session = sessions.find((item) => item.id === sessionId)
    const name = await prompt(t('drawer.renamePrompt'), session?.name || '')
    if (!name || name === session?.name) return
    try {
      const renamed = await renameSession.mutateAsync({ hostId: activeHostId, sessionId, name })
      if (renamed?.id && renamed.id !== sessionId) {
        try {
          await migrateSessionWorkspace.mutateAsync({ fromId: sessionId, toId: renamed.id })
        } catch {}
      }
      if (activeSessionId === sessionId && renamed?.id) setActiveSession(renamed.id)
      pushToast({ type: 'success', message: t('session.renamed', { from: session?.name || sessionId, to: name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
    }
  }
  const toggleBatchMode = () => {
    setBatchMode((prev) => !prev)
    setSelectedSessionIds([])
  }
  const toggleBatchSession = (sessionId: string) => {
    setSelectedSessionIds((prev) =>
      prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId],
    )
  }
  const handleAgentStatusClick = async (
    session: { id: string; agents?: { paneId: string; agentStatus: AgentStatus }[] },
    status: AgentStatus,
  ) => {
    const candidates = session.agents?.filter((agent) => agent.agentStatus === status)
    if (!candidates?.length || !activeHostId) return
    const currentPaneId = useConsoleStore.getState().activePaneId
    const currentIndex = candidates.findIndex((agent) => agent.paneId === currentPaneId)
    const nextIndex = (currentIndex + 1) % candidates.length
    const pane = candidates[nextIndex]
    try {
      const hostId = activeHostId
      const sessionId = session.id
      const key = ['session-snapshot', hostId, sessionId]
      const cached = queryClient?.getQueryData?.<SessionSnapshot>(key)
      const snapshot = cached?.panes?.some?.((p: Pane) => p.id === pane.paneId)
        ? cached
        : await api.snapshot.get(hostId, sessionId)
      const targetPane = snapshot?.panes?.find?.((p: Pane) => p.id === pane.paneId)
      if (!targetPane) return
      if (targetPane.windowId && targetPane.windowId !== snapshot.activeWindowId)
        await api.windows.select(hostId, sessionId, targetPane.windowId)
      await api.panes.select(pane.paneId)
      const nextSnapshot = await api.snapshot.get(hostId, sessionId)
      queryClient?.setQueryData(key, nextSnapshot)
      setActiveSession(sessionId)
      setActivePane(pane.paneId)
    } catch {}
  }
  useEffect(() => {
    const handleOpenTemplates = () => setShowTemplates(true)
    window.addEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
    return () => window.removeEventListener('tmuxgo-open-session-templates', handleOpenTemplates as EventListener)
  }, [])
  // 空状态「新建会话」入口：复用未分类创建流程（Default 模板）；
  // detail 可携带 worktree cwd/link（GitPanel worktrees 入口）
  useEffect(() => {
    const handleOpenCreate = (event: Event) => {
      if (!activeHostId) return
      const detail = (event as CustomEvent<{ cwd?: string; worktreeLink?: { repoPath: string; worktreePath: string } }>)
        .detail
      setCreateDialogTemplate(builtinTemplates[0] || null)
      setCreateDialogInitialWorkspace(null)
      setCreateDialogCwd(detail?.cwd || null)
      setCreateDialogWorktreeLink(detail?.worktreeLink || null)
      setCreateDialogOpen(true)
    }
    window.addEventListener('tmuxgo-open-create-session', handleOpenCreate)
    return () => window.removeEventListener('tmuxgo-open-create-session', handleOpenCreate)
  }, [activeHostId])
  useEffect(() => {
    setSelectedSessionIds((prev) => prev.filter((id) => sessions.some((item) => item.id === id)))
  }, [sessions])
  useEffect(() => {
    if (!workspaceMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [workspaceMenuOpen])
  const hostWorkspaces = useMemo(
    () => workspaces.filter((item) => item.hostId === activeHostId),
    [workspaces, activeHostId],
  )
  const workspaceGroups = useMemo(() => {
    const bySession = new Map(sessionWorkspaces.map((item) => [item.sessionId, item]))
    const groups = new Map<string, Session[]>()
    const groupKeyOf = (sessionId: string) => {
      const entry = bySession.get(sessionId)
      if (!entry) return ''
      if (entry.workspaceId && hostWorkspaces.some((item) => item.id === entry.workspaceId))
        return entry.workspaceId as string
      return hostWorkspaces.find((item) => item.path === entry.workspacePath)?.id || ''
    }
    for (const session of sessions) {
      const key = groupKeyOf(session.id)
      const list = groups.get(key) || []
      list.push(session)
      groups.set(key, list)
    }
    const rollup = (groupSessions: Session[]) =>
      mergeAgentSummaries(groupSessions.map((session) => session.agentSummary))
    // 组内按注意力 rank 稳定排序（Array.sort 稳定）：rank 小靠前，同档保持
    // 用户手动序（sessions 存储序）；排序只影响展示，不回写存储
    const byAttention = (groupSessions: Session[]) =>
      groupSessions
        .slice()
        .sort((a, b) => getAgentAttentionRank(a.agentSummary) - getAgentAttentionRank(b.agentSummary))
    const result: SessionGroup[] = []
    for (const workspace of hostWorkspaces) {
      const groupSessions = groups.get(workspace.id) || []
      result.push({
        key: workspace.id,
        workspace,
        sessions: byAttention(groupSessions),
        agentSummary: rollup(groupSessions),
      })
    }
    // 注意力排序：rank 越小越靠前，同档保持 workspace 原序；未分类是兜底组固定沉底
    result.sort((a, b) => getAgentAttentionRank(a.agentSummary) - getAgentAttentionRank(b.agentSummary))
    const unclassified = groups.get('')
    if (unclassified?.length)
      result.push({ key: '', workspace: null, sessions: byAttention(unclassified), agentSummary: rollup(unclassified) })
    return result
  }, [sessions, hostWorkspaces, sessionWorkspaces])
  const currentWorkspace =
    workspaceGroups.find((group) => group.sessions.some((session) => session.id === activeSessionId))?.workspace || null
  const hideWorkspaceGroups = preferences.hideWorkspaceGroups === true
  // 持久值可能来自旧版本/远端：非法值回落 manual，避免标签与比较器拿到未知规则
  const sortRule: SessionSortMode = SESSION_SORT_RULES.includes(preferences.sessionSortMode)
    ? preferences.sessionSortMode
    : 'manual'
  // 非 manual 排序下拖拽无意义（落不回持久序），统一禁用传感器
  const canDragSessions = sortRule === 'manual'
  // 分组模式的排序视图：组内按规则排，组间按组聚合值排，未分类恒定沉底。
  // manual 直接复用 workspaceGroups（现状：组内/组间都是注意力 rank）
  const sortedGroups = useMemo(() => {
    if (sortRule === 'manual') return workspaceGroups
    const groups = workspaceGroups
      .filter((group) => group.workspace)
      .map((group) => ({
        ...group,
        sessions: group.sessions.slice().sort((a, b) => compareSessionsByRule(sortRule, a, b)),
      }))
    groups.sort((a, b) => compareGroupsByRule(sortRule, a, b))
    const unclassified = workspaceGroups.find((group) => !group.workspace)
    if (unclassified)
      groups.push({
        ...unclassified,
        sessions: unclassified.sessions.slice().sort((a, b) => compareSessionsByRule(sortRule, a, b)),
      })
    return groups
  }, [workspaceGroups, sortRule])
  // flat 模式数据源：非 manual 直接对全量 sessions 排序；manual 必须用持久序——
  // flat 没有分组注意力聚合语义，若拍平 sortedGroups 的派生展示序，
  // 用户一次轻拖就会把 attention 序当手动序写回全局（SessionRail/CommandPalette 全跟着变）
  const flatSessions = useMemo(() => {
    if (sortRule !== 'manual') return sessions.slice().sort((a, b) => compareSessionsByRule(sortRule, a, b))
    return sessions
  }, [sessions, sortRule])

  // —— 跨组拖拽：DndContext 上移到此，预览序按组 key 存 ——
  // 粗指针端（iPad/触屏本）：长按激活延迟加长+死区加大，列表滚动/长按菜单优先，
  // 否则 TouchSensor 220ms 抢手势；桌面触控维持原延迟
  const coarsePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
  const sessionDndSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: coarsePointer ? { delay: 550, tolerance: 16 } : { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<Record<string, string[]> | null>(null)
  // flat 模式没有组 key，预览序退化成一条全量 id 列表（与单列表封装同语义）
  const [flatPreview, setFlatPreview] = useState<string[] | null>(null)
  const dragSourceKeyRef = useRef('')
  // 轮询驱动下时间/attention 规则会让行持续换位；行 hover（含悬浮卡驻留）期间
  // 冻结展示序，避免指针下的行溜走。冻结期间新建/删除的行等指针移开才刷新；
  // 起手拖拽即解冻（dragSessionId 排除），预览按最新数据源构建
  const frozenListRef = useRef<{ groups: SessionGroup[]; flat: Session[] } | null>(null)
  useEffect(() => {
    if (!hoverSession || dragSessionId) {
      frozenListRef.current = null
      return
    }
    if (!frozenListRef.current) frozenListRef.current = { groups: sortedGroups, flat: flatSessions }
  }, [hoverSession, dragSessionId, sortedGroups, flatSessions])
  const frozenList = hoverSession && !dragSessionId ? frozenListRef.current : null
  const visibleGroups = frozenList ? frozenList.groups : sortedGroups
  const visibleFlat = frozenList ? frozenList.flat : flatSessions
  // 拖拽期间未分类组即使为空也要渲染成可落点
  const displayedGroups = useMemo(() => {
    if (!dragPreview) return visibleGroups
    // orderByIds 空 ids 时返回全量 sessions（其语义是「无保存序则原序」），
    // 这里需要「按 id 过滤」语义——空预览组必须渲染为空，否则每行在每个组
    // 重复渲染，同 id 重复注册进 SortableContext 会污染 dnd-kit 内部状态
    const list = visibleGroups.map((group) => {
      const ids = dragPreview[group.key] || []
      return { ...group, sessions: ids.length ? orderByIds(sessions, ids) : [] }
    })
    if (!list.some((group) => group.key === ''))
      list.push({ key: '', workspace: null, sessions: [], agentSummary: mergeAgentSummaries([]) })
    return list
  }, [dragPreview, visibleGroups, sessions])
  const dragSession = sessions.find((item) => item.id === dragSessionId) || null
  // batch/拖拽进行中收回已弹出的 hover 卡（进入新行时 onMouseEnter 也有同样的拦截）
  useEffect(() => {
    if (batchMode || dragSessionId) setHoverAnchor(null)
  }, [batchMode, dragSessionId])
  const handleSessionDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    setDragSessionId(id)
    if (hideWorkspaceGroups) {
      setFlatPreview(flatSessions.map((session) => session.id))
      dragSourceKeyRef.current = ''
      return
    }
    const preview: Record<string, string[]> = {}
    for (const group of visibleGroups) preview[group.key] = group.sessions.map((session) => session.id)
    if (!('' in preview)) preview[''] = []
    setDragPreview(preview)
    dragSourceKeyRef.current = findPreviewGroup(preview, id) || ''
  }
  const handleSessionDragOver = (event: DragOverEvent) => {
    const activeId = event.active?.id ? String(event.active.id) : null
    const overId = event.over?.id ? String(event.over.id) : null
    if (!activeId || !overId || activeId === overId) return
    if (hideWorkspaceGroups) {
      // flat 列表没有组 dropzone：拖动即整表重排预览
      setFlatPreview((current) => {
        if (!current) return current
        const from = current.indexOf(activeId)
        const to = current.indexOf(overId)
        if (from === -1 || to === -1 || from === to) return current
        return arrayMove(current, from, to)
      })
      return
    }
    setDragPreview((current) => (current ? movePreviewBetweenGroups(current, activeId, overId) : current))
  }
  const resetSessionDrag = useCallback(() => {
    setDragSessionId(null)
    setDragPreview(null)
    setFlatPreview(null)
  }, [])
  // 视图模式/排序规则切换后旧预览语义失效（flat↔grouped 预览互不通用）：丢弃在途拖拽与悬浮锚点
  useEffect(() => {
    resetSessionDrag()
    setHoverAnchor(null)
  }, [hideWorkspaceGroups, sortRule, resetSessionDrag])
  const handleSessionDragEnd = (_event: DragEndEvent) => {
    const preview = dragPreview
    const flat = flatPreview
    const sessionId = dragSessionId
    resetSessionDrag()
    if (!sessionId) return
    // 拖拽中途偏好被另一标签页同步改掉（flat↔grouped 视图切换）时，
    // 预览属于旧视图，此时落盘会把顺序写进用户没在看的模式——直接放弃
    if (hideWorkspaceGroups ? !flat : !preview) return
    if (flat) {
      // flat：落点即全量顺序，无跨组归属变更；与持久序一致时不脏写
      // （对照 SessionSortableList.handleDragEnd 的 arraysEqual 守卫同标准）
      const persisted = sessions.map((session) => session.id)
      if (!sameIdOrder(flat, persisted)) moveSession(flat)
      return
    }
    if (!preview) return
    const targetKey = findPreviewGroup(preview, sessionId)
    if (targetKey != null && targetKey !== dragSourceKeyRef.current) {
      if (targetKey === '') {
        // 拖到未分类：删掉 workspace 归属即可，groupKeyOf 自动归 ''
        void removeSessionWorkspaces.mutateAsync([sessionId]).catch(() => {})
      } else {
        const workspace = hostWorkspaces.find((item) => item.id === targetKey)
        if (workspace && activeHostId)
          void setSessionWorkspace
            .mutateAsync({
              sessionId,
              hostId: activeHostId,
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              rootId: workspace.rootId,
              rootPath: workspace.rootPath,
              rootLabel: workspace.rootLabel,
              relativePath: workspace.relativePath,
              updatedAt: new Date().toISOString(),
            })
            .catch(() => {})
      }
    }
    // 全局序 = 各组预览序按显示顺序拼接（moveSession 收全量有序 id）
    const order = visibleGroups.map((group) => group.key)
    if ('' in preview && !order.includes('')) order.push('')
    moveSession(order.flatMap((key) => preview[key] || []))
  }
  const handleUnclassifiedCreateSession = () => {
    if (!activeHostId) return
    // 无 workspace 实体：直接开 Default 模板对话框，创建后不写 sessionWorkspaces → 落未分类
    setCreateDialogTemplate(builtinTemplates[0] || null)
    setCreateDialogInitialWorkspace(null)
    setCreateDialogOpen(true)
  }
  const sessionItemClassName = ({ session, isDragging, isOverlay }: GetClassNameArgs) =>
    `group tmuxgo-list-row ${batchMode ? (selectedSessionIds.includes(session.id) ? 'tmuxgo-list-row--batch' : 'tmuxgo-list-row--hover') : activeSessionId === session.id ? 'tmuxgo-list-row--active' : 'tmuxgo-list-row--hover'} ${isDragging && !isOverlay ? 'opacity-40' : ''} ${isOverlay ? 'rounded-apple border border-accent bg-bg-1' : ''}`
  const renderSessionItem = ({ session }: RenderSessionArgs) => (
    <div
      className="flex items-center gap-1 pr-2"
      onMouseEnter={(event) => {
        // 拖拽中 / batch 模式不弹悬浮预览卡（组件自身不做业务判断，由这里不给锚点）
        if (batchMode || dragSessionId) return
        setHoverSession({ id: session.id, name: session.name })
        setHoverAnchor(event.currentTarget.getBoundingClientRect())
      }}
      onMouseLeave={() => setHoverAnchor(null)}
    >
      {batchMode && (
        <button
          onClick={() => toggleBatchSession(session.id)}
          className={`ml-2 flex h-9 w-6 shrink-0 items-center justify-center rounded-apple text-meta leading-none ${selectedSessionIds.includes(session.id) ? 'text-danger' : 'text-text-3'} hover:bg-bg-0`}
        >
          {selectedSessionIds.includes(session.id) ? '☑' : '☐'}
        </button>
      )}
      <button
        onClick={() => (batchMode ? toggleBatchSession(session.id) : setActiveSession(session.id))}
        onDoubleClick={() => !batchMode && void handleRenameSession(session.id)}
        className={`min-w-0 flex-1 px-3 py-2 text-left ${batchMode && selectedSessionIds.includes(session.id) ? 'border-l-2 border-danger' : ''}`}
      >
        <div className="tmuxgo-session-name truncate text-[13px] text-text-1">{session.name}</div>
        <div className="tmuxgo-session-meta mt-1 flex min-w-0 items-center gap-2">
          <span className="shrink-0 whitespace-nowrap">{t('sidebar.windows', { count: session.windowCount })}</span>
          <AgentStatusBadge
            summary={session.agentSummary}
            onStatusClick={(status) => handleAgentStatusClick(session, status)}
          />
        </div>
      </button>
      {!batchMode && (
        <button
          onClick={() => void handleRenameSession(session.id)}
          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-9 w-9 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={t('sidebar.renameSession')}
          title={t('sidebar.renameSession')}
        >
          ✎
        </button>
      )}
      {!batchMode && (
        <button
          onClick={() => void handleExportSessionLayout(session)}
          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-9 w-9 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={t('sidebar.exportLayout')}
          title={t('sidebar.exportLayout')}
        >
          <FiDownload aria-hidden="true" size={13} />
        </button>
      )}
      {!batchMode && (
        <button
          onClick={() => setPendingDeleteSessionId(session.id)}
          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-9 w-9 text-meta opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={t('sidebar.deleteSession')}
          title={t('sidebar.deleteSession')}
        >
          ×
        </button>
      )}
    </div>
  )
  // 组头容器样式直接落在 SessionGroupDropZone 上（见 SessionGroupedSortableList 注释：
  // sticky 需要列表容器作包含块，不能再套只包组头的中间层），这里只产出内部内容
  const groupHeaderClassName =
    'group sticky top-0 z-10 relative flex items-center gap-1 border-b border-[var(--line)] bg-[rgb(var(--bg-1))] px-3 py-1.5'
  const renderGroupHeader = (workspace: WorkspaceEntry | null) =>
    workspace ? (
      <>
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">
          {workspace.name}
        </span>
        {!batchMode && (
          <button
            onClick={() => handleWorkspaceCreateSession(workspace)}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t('workspace.newSession')}
            title={t('workspace.newSession')}
          >
            ＋
          </button>
        )}
        {!batchMode && (
          <button
            onClick={() => void handleWorkspaceRename(workspace)}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t('workspace.rename')}
            title={t('workspace.rename')}
          >
            ✎
          </button>
        )}
        {!batchMode && (
          <button
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              if (templateMenu?.workspace.id === workspace.id) return setTemplateMenu(null)
              const rect = event.currentTarget.getBoundingClientRect()
              setTemplateMenu({ workspace, top: rect.bottom + 4, right: window.innerWidth - rect.right })
            }}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t('workspace.template')}
            title={t('workspace.template')}
          >
            ▦
          </button>
        )}
        {!batchMode && (
          <button
            onClick={() => setPendingDeleteWorkspace(workspace)}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t('workspace.delete')}
            title={t('workspace.delete')}
          >
            🗑
          </button>
        )}
        {templateMenu?.workspace.id === workspace.id && (
          <ModalPortal>
            {/* 组头带 backdrop-blur（成为 fixed 后代的包含块）且列表容器 overflow 裁剪——
                菜单必须 portal 到 body 用 fixed 定位，否则被 sticky 头/滚动边界裁掉 */}
            <div
              className="tmuxgo-menu fixed z-[90] max-h-56 w-44 overflow-y-auto py-1 text-xs"
              style={{ top: templateMenu.top, right: templateMenu.right }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {allTemplates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => void handleWorkspaceSetTemplate(workspace, template.id)}
                  className={`tmuxgo-menu-item truncate text-xs ${workspace.templateId === template.id ? 'text-accent' : ''}`}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </ModalPortal>
        )}
      </>
    ) : (
      <>
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">
          {t('workspace.unclassified')}
        </span>
        {!batchMode && (
          <button
            onClick={handleUnclassifiedCreateSession}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t('sidebar.newAction')}
            title={t('sidebar.newAction')}
          >
            ＋
          </button>
        )}
      </>
    )
  const handleNewSession = () => {
    if (!activeHostId) return
    if (!hostWorkspaces.length) {
      setWorkspacePickerOpen(true)
      return
    }
    if (currentWorkspace) {
      handleWorkspaceCreateSession(currentWorkspace)
      return
    }
    setWorkspaceMenuOpen(true)
  }
  const handleWorkspaceSelect = (workspace: WorkspaceEntry) => {
    const session = workspaceGroups.find((group) => group.workspace?.id === workspace.id)?.sessions[0]
    setWorkspaceMenuOpen(false)
    if (session) {
      setActiveSession(session.id)
      return
    }
    handleWorkspaceCreateSession(workspace)
  }
  const handleWorkspaceDirectoryPick = async (target: WorkspaceDirectoryTarget) => {
    if (!activeHostId) return
    const existing = hostWorkspaces.find((item) => item.path === target.absolutePath)
    if (existing) {
      setWorkspacePickerOpen(false)
      handleWorkspaceSelect(existing)
      return
    }
    const name = target.relativePath.split('/').filter(Boolean).pop() || target.rootLabel
    try {
      const created = await createWorkspace.mutateAsync({
        name: name.slice(0, 64),
        hostId: activeHostId,
        path: target.absolutePath,
        rootId: target.rootId,
        rootPath: target.rootPath,
        rootLabel: target.rootLabel,
        relativePath: target.relativePath,
      })
      setWorkspacePickerOpen(false)
      handleWorkspaceCreateSession(created.workspace)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('workspace.requestFailed') })
      throw err
    }
  }
  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-transparent">
        <div data-testid="session-panel-header" className="tmuxgo-shell-sidebar__header">
          {/* 主机条独占一行（名称不再被工作区挤成 truncate），工作区 + 主操作在第二行 */}
          <HostSwitcher />
          <div className="mt-2 flex items-center gap-2">
            <div ref={workspaceMenuRef} className="relative min-w-0 flex-1">
              <button
                onClick={() => {
                  if (!activeHostId || batchMode) return
                  if (!hostWorkspaces.length) setWorkspacePickerOpen(true)
                  else setWorkspaceMenuOpen((value) => !value)
                }}
                className="tmuxgo-control flex h-8 w-full items-center gap-2 rounded-apple px-2 text-left text-xs text-text-2 hover:border-accent/50 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={batchMode}
                aria-label={`${t('workspace.current')}: ${currentWorkspace?.name || t('workspace.choose')}`}
              >
                <FiFolder aria-hidden="true" className="shrink-0 text-accent" size={14} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {currentWorkspace?.name || t('workspace.choose')}
                </span>
                <FiChevronDown aria-hidden="true" className="shrink-0 text-text-3" size={14} />
              </button>
              {workspaceMenuOpen && (
                <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 overflow-hidden rounded-apple border border-[var(--line)] bg-bg-1 py-1">
                  <div className="tmuxgo-scrollbar max-h-64 overflow-y-auto">
                    {/* 下拉项与列表分组同序：都走 sortedGroups（当前排序规则），
                      徽标语义一致（同一 rollup summary），不再用 hostWorkspaces 原序；
                      done 徽标可标记已查看，清除语义与列表项一致 */}
                    {sortedGroups.flatMap((group) =>
                      group.workspace ? (
                        <button
                          key={group.workspace.id}
                          onClick={() => handleWorkspaceSelect(group.workspace!)}
                          className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs ${currentWorkspace?.id === group.workspace.id ? 'bg-accent/10 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'}`}
                          aria-label={group.workspace.name}
                        >
                          <FiFolder aria-hidden="true" className="shrink-0 text-[#dcb67a]" size={14} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{group.workspace.name}</span>
                            <span className="block truncate font-mono text-caption text-text-3">
                              {group.workspace.path}
                            </span>
                          </span>
                          <AgentStatusBadge summary={group.agentSummary} compact />
                          {currentWorkspace?.id === group.workspace.id && (
                            <FiCheck aria-hidden="true" className="shrink-0 text-accent" size={14} />
                          )}
                        </button>
                      ) : (
                        []
                      ),
                    )}
                  </div>
                  <div className="border-t border-[var(--line)] p-1">
                    <button
                      onClick={() => {
                        setWorkspaceMenuOpen(false)
                        setWorkspacePickerOpen(true)
                      }}
                      className="flex w-full items-center gap-2 rounded-apple px-2 py-2 text-left text-xs text-accent hover:bg-bg-2"
                    >
                      <FiFolderPlus aria-hidden="true" size={14} />
                      {t('workspace.add')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {!batchMode && (
              <Chip
                tone="accent"
                data-session-action="true"
                onClick={handleNewSession}
                className="shrink-0 justify-center px-0"
                title={t('sidebar.newAction')}
                aria-label={t('sidebar.newAction')}
              >
                <FiPlus aria-hidden="true" size={16} strokeWidth={2.4} />
              </Chip>
            )}
          </div>
          <div className="tmuxgo-shell-sidebar__tools">
            {!batchMode && <span className="tmuxgo-micro min-w-0 truncate">{t('sidebar.sessions')}</span>}
            {batchMode && (
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-3">
                {t('sidebar.batchSelectedCount', { count: selectedSessionIds.length })}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {batchMode ? (
                <>
                  <Chip onClick={() => setSelectedSessionIds(sessions.map((session) => session.id))}>
                    {t('sidebar.batchSelectAll')}
                  </Chip>
                  <Chip onClick={() => setSelectedSessionIds([])}>{t('sidebar.batchClearAll')}</Chip>
                  <Chip
                    tone="danger"
                    disabled={!selectedSessionIds.length}
                    onClick={() => setBatchDeleteConfirmOpen(true)}
                  >
                    {t('sidebar.batchDeleteSelected')}
                  </Chip>
                  <Chip tone="accent" onClick={toggleBatchMode}>
                    {t('sidebar.batchCancelAction')}
                  </Chip>
                </>
              ) : (
                <>
                  {/* 次要工具：新建已提到工作区行的主操作位，这里只留低频动作 */}
                  <Chip
                    data-session-action="true"
                    onClick={() => setShowLayoutImport(true)}
                    disabled={!activeHostId}
                    className="px-2 py-1"
                    title={t('sidebar.importLayout')}
                    aria-label={t('sidebar.importLayout')}
                  >
                    <FiUpload aria-hidden="true" size={13} />
                  </Chip>
                  <Chip
                    data-session-action="true"
                    tone={sortRule === 'manual' ? 'default' : 'accent'}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      if (sortMenu) return setSortMenu(null)
                      const rect = event.currentTarget.getBoundingClientRect()
                      setSortMenu({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                    }}
                    className="px-2 py-1"
                    title={`${t('sidebar.sort')}: ${t(SESSION_SORT_LABELS[sortRule])}`}
                    aria-label={t('sidebar.sort')}
                    aria-pressed={sortRule !== 'manual'}
                  >
                    <FiChevronsDown aria-hidden="true" size={13} />
                  </Chip>
                  <Chip
                    data-session-action="true"
                    tone={hideWorkspaceGroups ? 'accent' : 'default'}
                    onClick={() => updatePreferences({ hideWorkspaceGroups: !hideWorkspaceGroups })}
                    className="px-2 py-1"
                    title={t('sidebar.toggleWorkspaceGroups')}
                    aria-label={t('sidebar.toggleWorkspaceGroups')}
                    aria-pressed={hideWorkspaceGroups}
                  >
                    <FiLayers aria-hidden="true" size={13} />
                  </Chip>
                  <Chip
                    data-session-action="true"
                    onClick={toggleBatchMode}
                    className="px-2 py-1"
                    title={t('sidebar.batchDeleteAction')}
                    aria-label={t('sidebar.batchDeleteAction')}
                  >
                    <FiMoreHorizontal aria-hidden="true" size={13} />
                  </Chip>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {isError && !sessions.length ? (
            <div className="p-3 text-xs text-danger">
              <div className="break-words">{error instanceof Error ? error.message : t('session.loadFailed')}</div>
              <button
                onClick={refreshSessions}
                className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm mt-2 w-auto px-2 text-accent"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <DndContext
              sensors={canDragSessions ? sessionDndSensors : NO_SENSORS}
              collisionDetection={closestCenter}
              onDragStart={handleSessionDragStart}
              onDragOver={handleSessionDragOver}
              onDragEnd={handleSessionDragEnd}
              onDragCancel={resetSessionDrag}
            >
              {hideWorkspaceGroups ? (
                // flat 模式绕过 grouped list：不渲染任何组头/未分类头，也不留占位空白；
                // 仍在同一 DndContext 内（SessionSortableList 依赖共享 context 才能拖拽）
                <SessionSortableList
                  sessions={flatPreview ? orderByIds(visibleFlat, flatPreview) : visibleFlat}
                  listClassName="min-h-full"
                  getItemClassName={sessionItemClassName}
                  renderItem={renderSessionItem}
                />
              ) : (
                <SessionGroupedSortableList
                  listClassName="min-h-full"
                  getItemClassName={sessionItemClassName}
                  renderItem={renderSessionItem}
                  groups={displayedGroups.map(({ key, workspace, sessions: groupSessions }) => ({
                    key,
                    sessions: groupSessions,
                    header: renderGroupHeader(workspace),
                    headerClassName: groupHeaderClassName,
                  }))}
                />
              )}
              {/* DragOverlay 必须 portal 出容器：内联 fixed 会被 backdrop-filter/
                  transform 祖先当作包含块，top 按面板坐标解析导致位置大幅偏移 */}
              <ModalPortal>
                <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
                  {dragSession ? (
                    <div className={sessionItemClassName({ session: dragSession, isDragging: true, isOverlay: true })}>
                      {renderSessionItem({ session: dragSession, isDragging: true, isOverlay: true })}
                    </div>
                  ) : null}
                </DragOverlay>
              </ModalPortal>
            </DndContext>
          )}
        </div>
        {preferences.showQuickActions && (
          <div className="tmuxgo-quick-panel">
            <div className="mb-2 flex items-center justify-between">
              <div className="tmuxgo-micro">{t('sidebar.quickActions')}</div>
              {/* 桌面端快捷键栏开关：开启后 dock 栏占用底部状态栏位置，见 ConsoleLayout */}
              <button
                type="button"
                onClick={() => updatePreferences({ showShortcutBar: !preferences.showShortcutBar })}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-apple transition-colors ${preferences.showShortcutBar ? 'bg-accent/15 text-accent' : 'text-text-3 hover:bg-accent/15 hover:text-accent'}`}
                aria-label={t('shortcut.toggleDock')}
                aria-pressed={preferences.showShortcutBar}
                title={t('shortcut.toggleDock')}
              >
                <FiCommand aria-hidden="true" size={13} />
              </button>
            </div>
            <QuickActions />
          </div>
        )}
      </div>
      {hoverSession && activeHostId && (
        <SessionHoverCard
          hostId={activeHostId}
          sessionId={hoverSession.id}
          sessionName={hoverSession.name}
          anchorRect={hoverAnchor}
          onClose={() => setHoverSession(null)}
        />
      )}
      {sortMenu && (
        <ModalPortal>
          {/* 面板容器带 backdrop-blur/滚动裁剪，菜单必须 portal + fixed（同组头模板菜单） */}
          <div
            className="tmuxgo-menu fixed z-[90] w-44 py-1 text-xs"
            style={{ top: sortMenu.top, right: sortMenu.right }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {SESSION_SORTS.map((item) => (
              <button
                key={item.rule}
                onClick={() => {
                  updatePreferences({ sessionSortMode: item.rule })
                  setSortMenu(null)
                }}
                className={`tmuxgo-menu-item truncate text-xs ${sortRule === item.rule ? 'text-accent' : ''}`}
              >
                {t(item.labelKey)}
              </button>
            ))}
            {!canDragSessions && (
              <div className="px-2 pt-1 text-caption leading-tight text-text-3">{t('sidebar.sortDragHint')}</div>
            )}
          </div>
        </ModalPortal>
      )}
      {showTemplates && (
        <ModalPortal>
          <SessionTemplates
            onSelect={handleTemplateSelect}
            onClose={() => {
              setShowTemplates(false)
              setTemplateWorkspace(null)
            }}
          />
        </ModalPortal>
      )}
      <SessionLayoutImportDialog
        open={showLayoutImport && !!activeHostId}
        hostId={activeHostId || ''}
        sessions={sessions}
        activeSessionId={activeSessionId || ''}
        onApplied={handleLayoutApplied}
        onClose={() => setShowLayoutImport(false)}
      />
      {workspacePickerOpen && (
        <WorkspaceDirectoryPicker
          hostId={activeHostId || ''}
          onPick={handleWorkspaceDirectoryPick}
          onClose={() => setWorkspacePickerOpen(false)}
        />
      )}
      <CreateSessionDialog
        open={createDialogOpen}
        template={createDialogTemplate}
        defaultName={
          createDialogTemplate
            ? getDefaultSessionName(createDialogTemplate, sessions, createDialogInitialWorkspace?.name)
            : ''
        }
        hostId={activeHostId || ''}
        workspaces={workspaces}
        initialWorkspace={createDialogInitialWorkspace}
        initialCwd={createDialogCwd}
        workspaceLocked={!!createDialogInitialWorkspace}
        onCreate={handleCreateSession}
        onClose={() => {
          setCreateDialogOpen(false)
          setCreateDialogTemplate(null)
          setCreateDialogInitialWorkspace(null)
          setCreateDialogCwd(null)
          setCreateDialogWorktreeLink(null)
        }}
      />
      <ConfirmDialog
        open={!!pendingDeleteSessionId}
        title={t('sidebar.deleteTitle')}
        message={t('sidebar.deleteConfirm', {
          name: sessions.find((item) => item.id === pendingDeleteSessionId)?.name || '',
        })}
        confirmLabel={t('sidebar.confirmDelete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteSessionId(null)}
        onConfirm={confirmDeleteSession}
      />
      <ConfirmDialog
        open={!!pendingDeleteWorkspace}
        title={t('workspace.deleteTitle')}
        message={t('workspace.deleteConfirm', { name: pendingDeleteWorkspace?.name || '' })}
        confirmLabel={t('workspace.deleteAction')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteWorkspace(null)}
        onConfirm={confirmDeleteWorkspace}
      />
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        title={t('sidebar.batchDeleteTitle')}
        message={t('sidebar.batchDeleteConfirm', { count: selectedSessionIds.length })}
        items={sessions.filter((session) => selectedSessionIds.includes(session.id)).map((session) => session.name)}
        confirmLabel={t('sidebar.batchDeleteSelected')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setBatchDeleteConfirmOpen(false)}
        onConfirm={confirmBatchDeleteSession}
      />
      {PromptElement}
    </>
  )
}
