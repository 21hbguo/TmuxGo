'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { CreateSessionDialog } from './CreateSessionDialog'
import { getTemplateSessionName } from '@/lib/session-template'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { QuickActions } from './QuickActions'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'
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
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import {
  SessionSortableList,
  SessionGroupDropZone,
  findPreviewGroup,
  movePreviewBetweenGroups,
  orderByIds,
  type GetClassNameArgs,
  type RenderSessionArgs,
} from './SessionSortableList'
import { HostSwitcher } from './HostSwitcher'
import { AgentStatusBadge } from './AgentStatusBadge'
import type { AgentStatus, Session, WorkspaceEntry } from '@/types'
import { ModalPortal } from './ModalPortal'
import { api } from '@/lib/api'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { WorkspaceDirectoryPicker, type WorkspaceDirectoryTarget } from './WorkspaceDirectoryPicker'
import { FiCheck, FiChevronDown, FiFolder, FiFolderPlus } from 'react-icons/fi'

function getNextSessionId(sessions: { id: string }[], removedIds: string[]) {
  const removed = new Set(removedIds)
  return sessions.find((item) => !removed.has(item.id))?.id || ''
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
  const [templateWorkspace, setTemplateWorkspace] = useState<WorkspaceEntry | null>(null)
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceEntry | null>(null)
  const [templateMenuWorkspaceId, setTemplateMenuWorkspaceId] = useState<string | null>(null)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const [showTemplates, setShowTemplates] = useState(false)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)
  const [createDialogTemplate, setCreateDialogTemplate] = useState<Template | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const handleTemplateSelect = (template: Template) => {
    if (!activeHostId) return
    setShowTemplates(false)
    setCreateDialogTemplate(template)
    setCreateDialogInitialWorkspace(templateWorkspace)
    setTemplateWorkspace(null)
    setCreateDialogOpen(true)
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
    setTemplateMenuWorkspaceId(null)
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
        setActiveSession(created.id)
        pushToast({ type: 'success', message: t('session.created', { name }) })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('session.requestFailed') })
      throw err
    }
    setCreateDialogOpen(false)
    setCreateDialogTemplate(null)
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
      const cached = queryClient?.getQueryData?.(key) as any
      const snapshot = cached?.panes?.some?.((p: any) => p.id === pane.paneId)
        ? cached
        : await api.snapshot.get(hostId, sessionId)
      const targetPane = snapshot?.panes?.find?.((p: any) => p.id === pane.paneId)
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
  // 空状态「新建会话」入口：复用未分类创建流程（Default 模板）
  useEffect(() => {
    const handleOpenCreate = () => {
      if (!activeHostId) return
      setCreateDialogTemplate(builtinTemplates[0] || null)
      setCreateDialogInitialWorkspace(null)
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
    const result: { key: string; workspace: WorkspaceEntry | null; sessions: Session[] }[] = []
    for (const workspace of hostWorkspaces) {
      result.push({ key: workspace.id, workspace, sessions: groups.get(workspace.id) || [] })
    }
    const unclassified = groups.get('')
    if (unclassified?.length) result.push({ key: '', workspace: null, sessions: unclassified })
    return result
  }, [sessions, hostWorkspaces, sessionWorkspaces])
  const currentWorkspace =
    workspaceGroups.find((group) => group.sessions.some((session) => session.id === activeSessionId))?.workspace || null
  // —— 跨组拖拽：DndContext 上移到此，预览序按组 key 存 ——
  const sessionDndSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<Record<string, string[]> | null>(null)
  const dragSourceKeyRef = useRef('')
  // 拖拽期间未分类组即使为空也要渲染成可落点
  const displayedGroups = useMemo(() => {
    if (!dragPreview) return workspaceGroups
    const list = workspaceGroups.map((group) => ({
      ...group,
      sessions: orderByIds(sessions, dragPreview[group.key] || []),
    }))
    if (!list.some((group) => group.key === '')) list.push({ key: '', workspace: null, sessions: [] })
    return list
  }, [dragPreview, workspaceGroups, sessions])
  const dragSession = sessions.find((item) => item.id === dragSessionId) || null
  const handleSessionDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    setDragSessionId(id)
    const preview: Record<string, string[]> = {}
    for (const group of workspaceGroups) preview[group.key] = group.sessions.map((session) => session.id)
    if (!('' in preview)) preview[''] = []
    setDragPreview(preview)
    dragSourceKeyRef.current = findPreviewGroup(preview, id) || ''
  }
  const handleSessionDragOver = (event: DragOverEvent) => {
    const activeId = event.active?.id ? String(event.active.id) : null
    const overId = event.over?.id ? String(event.over.id) : null
    if (!activeId || !overId || activeId === overId) return
    setDragPreview((current) => (current ? movePreviewBetweenGroups(current, activeId, overId) : current))
  }
  const resetSessionDrag = () => {
    setDragSessionId(null)
    setDragPreview(null)
  }
  const handleSessionDragEnd = (_event: DragEndEvent) => {
    const preview = dragPreview
    const sessionId = dragSessionId
    resetSessionDrag()
    if (!preview || !sessionId) return
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
    const order = workspaceGroups.map((group) => group.key)
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
    `group tmuxgo-list-row mx-2 my-1 rounded-apple border border-transparent ${batchMode ? (selectedSessionIds.includes(session.id) ? 'tmuxgo-list-row--batch' : 'tmuxgo-list-row--hover') : activeSessionId === session.id ? 'tmuxgo-list-row--active' : 'tmuxgo-list-row--hover'} ${isDragging && !isOverlay ? 'opacity-40' : ''} ${isOverlay ? 'border-accent bg-bg-1 shadow-lg' : ''}`
  const renderSessionItem = ({ session }: RenderSessionArgs) => (
    <div className="flex items-center gap-1 pr-2">
      {batchMode && (
        <button
          onClick={() => toggleBatchSession(session.id)}
          className={`ml-2 flex h-7 w-5 shrink-0 items-center justify-center rounded-apple text-meta leading-none ${selectedSessionIds.includes(session.id) ? 'text-danger' : 'text-text-3'} hover:bg-bg-0`}
        >
          {selectedSessionIds.includes(session.id) ? '☑' : '☐'}
        </button>
      )}
      <button
        onClick={() => (batchMode ? toggleBatchSession(session.id) : setActiveSession(session.id))}
        onDoubleClick={() => !batchMode && void handleRenameSession(session.id)}
        className="min-w-0 flex-1 px-2.5 py-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeSessionId === session.id && !batchMode ? 'bg-accent' : 'bg-text-3/40'}`}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">{session.name}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-3.5 text-meta text-text-3">
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
          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-7 w-7 text-meta transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          aria-label={t('sidebar.renameSession')}
          title={t('sidebar.renameSession')}
        >
          ✎
        </button>
      )}
      {!batchMode && (
        <button
          onClick={() => setPendingDeleteSessionId(session.id)}
          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-7 w-7 text-meta transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          aria-label={t('sidebar.deleteSession')}
          title={t('sidebar.deleteSession')}
        >
          ×
        </button>
      )}
    </div>
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
        <div className="border-b border-[var(--line)] px-3 py-2">
          <HostSwitcher />
          <div ref={workspaceMenuRef} className="relative mt-2">
            <button
              onClick={() => {
                if (!activeHostId || batchMode) return
                if (!hostWorkspaces.length) setWorkspacePickerOpen(true)
                else setWorkspaceMenuOpen((value) => !value)
              }}
              className="tmuxgo-control flex min-h-10 w-full items-center gap-2 rounded-apple px-2.5 py-1.5 text-left text-xs text-text-2 hover:border-accent/50 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={batchMode}
              aria-label={`${t('workspace.current')}: ${currentWorkspace?.name || t('workspace.choose')}`}
            >
              <FiFolder aria-hidden="true" className="shrink-0 text-accent" size={14} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-text-1">
                  {currentWorkspace?.name || t('workspace.choose')}
                </span>
                {currentWorkspace && (
                  <span className="mt-0.5 block truncate font-mono text-caption text-text-3">
                    {currentWorkspace.path}
                  </span>
                )}
              </span>
              <FiChevronDown aria-hidden="true" className="shrink-0 text-text-3" size={14} />
            </button>
            {workspaceMenuOpen && (
              <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 overflow-hidden rounded-apple border border-[var(--line)] bg-bg-1 py-1">
                <div className="tmuxgo-scrollbar max-h-64 overflow-y-auto">
                  {hostWorkspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      onClick={() => handleWorkspaceSelect(workspace)}
                      className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs ${currentWorkspace?.id === workspace.id ? 'bg-accent/10 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'}`}
                      aria-label={workspace.name}
                    >
                      <FiFolder aria-hidden="true" className="shrink-0 text-[#dcb67a]" size={14} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{workspace.name}</span>
                        <span className="block truncate font-mono text-caption text-text-3">{workspace.path}</span>
                      </span>
                      {currentWorkspace?.id === workspace.id && (
                        <FiCheck aria-hidden="true" className="shrink-0 text-accent" size={14} />
                      )}
                    </button>
                  ))}
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
          <div className="mt-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-text-1">
              {batchMode
                ? t('sidebar.batchSelectedCount', { count: selectedSessionIds.length })
                : t('sidebar.sessions')}
            </div>
            <div className="flex items-center gap-1">
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
                  <Chip tone="accent" onClick={handleNewSession}>
                    {t('sidebar.newAction')}
                  </Chip>
                  <Chip onClick={toggleBatchMode}>{t('sidebar.batchDeleteAction')}</Chip>
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
                onClick={() => void refetch()}
                className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm mt-2 w-auto px-2 text-accent"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <DndContext
              sensors={sessionDndSensors}
              collisionDetection={closestCenter}
              onDragStart={handleSessionDragStart}
              onDragOver={handleSessionDragOver}
              onDragEnd={handleSessionDragEnd}
              onDragCancel={resetSessionDrag}
            >
              {displayedGroups.map(({ key, workspace, sessions: groupSessions }) => (
                <SessionGroupDropZone key={key || 'unclassified'} id={`group:${key}`}>
                  {workspace ? (
                    <div className="group sticky top-0 z-10 relative mx-2 mt-2 flex items-center gap-2 rounded-apple border border-[var(--line)] bg-bg-0/95 px-2.5 py-1.5 backdrop-blur">
                      <FiFolder aria-hidden="true" className="shrink-0 text-accent" size={13} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-text-1">{workspace.name}</span>
                        <span className="block truncate font-mono text-[10px] leading-4 text-text-3">{workspace.path}</span>
                      </span>
                      <span className="rounded-full bg-bg-2 px-1.5 py-0.5 text-caption tabular-nums text-text-3">
                        {groupSessions.length}
                      </span>
                      {!batchMode && (
                        <button
                          onClick={() => handleWorkspaceCreateSession(workspace)}
                          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          aria-label={t('workspace.newSession')}
                          title={t('workspace.newSession')}
                        >
                          ＋
                        </button>
                      )}
                      {!batchMode && (
                        <button
                          onClick={() => void handleWorkspaceRename(workspace)}
                          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          aria-label={t('workspace.rename')}
                          title={t('workspace.rename')}
                        >
                          ✎
                        </button>
                      )}
                      {!batchMode && (
                        <button
                          onClick={() =>
                            setTemplateMenuWorkspaceId(templateMenuWorkspaceId === workspace.id ? null : workspace.id)
                          }
                          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          aria-label={t('workspace.template')}
                          title={t('workspace.template')}
                        >
                          ▦
                        </button>
                      )}
                      {!batchMode && (
                        <button
                          onClick={() => setPendingDeleteWorkspace(workspace)}
                          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta transition-opacity hover:text-danger md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          aria-label={t('workspace.delete')}
                          title={t('workspace.delete')}
                        >
                          🗑
                        </button>
                      )}
                      {templateMenuWorkspaceId === workspace.id && (
                        <div className="absolute right-2 top-7 z-20 max-h-56 overflow-y-auto rounded-apple border border-[var(--line)] bg-bg-1 p-1">
                          {allTemplates.map((template) => (
                            <button
                              key={template.id}
                              onClick={() => void handleWorkspaceSetTemplate(workspace, template.id)}
                              className={`block w-full truncate rounded-apple px-2 py-1 text-left text-xs hover:bg-bg-0 ${workspace.templateId === template.id ? 'text-accent' : 'text-text-1'}`}
                            >
                              {template.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="group sticky top-0 z-10 relative mx-2 mt-2 flex items-center gap-2 rounded-apple border border-dashed border-[var(--line)] bg-bg-0/80 px-2.5 py-1.5 backdrop-blur">
                      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-3/35" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-3">
                        {t('workspace.unclassified')}
                      </span>
                      <span className="rounded-full bg-bg-2 px-1.5 py-0.5 text-caption tabular-nums text-text-3">
                        {groupSessions.length}
                      </span>
                      {!batchMode && (
                        <button
                          onClick={handleUnclassifiedCreateSession}
                          className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-6 w-6 text-meta transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          aria-label={t('sidebar.newAction')}
                          title={t('sidebar.newAction')}
                        >
                          ＋
                        </button>
                      )}
                    </div>
                  )}
                  <SessionSortableList
                    sessions={groupSessions}
                    listClassName="min-h-full"
                    getItemClassName={sessionItemClassName}
                    renderItem={renderSessionItem}
                  />
                </SessionGroupDropZone>
              ))}
              <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
                {dragSession ? (
                  <div className={sessionItemClassName({ session: dragSession, isDragging: true, isOverlay: true })}>
                    {renderSessionItem({ session: dragSession, isDragging: true, isOverlay: true })}
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
        {preferences.showQuickActions && (
          <div className="border-t border-[var(--line)] p-3">
            <div className="mb-2 text-caption uppercase tracking-[0.18em] text-text-3">{t('sidebar.quickActions')}</div>
            <QuickActions />
          </div>
        )}
      </div>
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
            ? createDialogInitialWorkspace
              ? `${createDialogInitialWorkspace.name}-${getTemplateSessionName(createDialogTemplate)}`
              : getTemplateSessionName(createDialogTemplate)
            : ''
        }
        hostId={activeHostId || ''}
        workspaces={workspaces}
        initialWorkspace={createDialogInitialWorkspace}
        workspaceLocked={!!createDialogInitialWorkspace}
        onCreate={handleCreateSession}
        onClose={() => {
          setCreateDialogOpen(false)
          setCreateDialogTemplate(null)
          setCreateDialogInitialWorkspace(null)
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
