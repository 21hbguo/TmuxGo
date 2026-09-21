'use client'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDndContext,
  useDroppable,
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
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@/types'

export type RenderSessionArgs = {
  session: Session
  isDragging: boolean
  isOverlay: boolean
}

export type GetClassNameArgs = {
  session: Session
  isDragging: boolean
  isOverlay: boolean
}

export function orderByIds(sessions: Session[], ids: string[]) {
  if (!ids.length) return sessions
  const map = new Map(sessions.map((session) => [session.id, session]))
  return ids.map((id) => map.get(id)).filter((session): session is Session => !!session)
}
function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function SortableSessionItem({
  session,
  renderItem,
  className,
}: {
  session: Session
  renderItem: (args: RenderSessionArgs) => ReactNode
  className?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`touch-pan-y select-none cursor-grab active:cursor-grabbing ${className ?? ''}`}
      {...attributes}
      {...listeners}
    >
      {renderItem({ session, isDragging, isOverlay: false })}
    </div>
  )
}

export function findPreviewGroup(preview: Record<string, string[]>, sessionId: string) {
  return Object.keys(preview).find((key) => preview[key].includes(sessionId)) ?? null
}
// 跨组拖拽预览迁移：overId 是 'group:key'（容器）或某个 session id（取所在组+其位置）
export function movePreviewBetweenGroups(preview: Record<string, string[]>, activeId: string, overId: string) {
  const sourceKey = findPreviewGroup(preview, activeId)
  let target: { key: string; index: number } | null = null
  if (overId.startsWith('group:')) {
    const key = overId.slice('group:'.length)
    target = { key, index: preview[key]?.length ?? 0 }
  } else {
    const key = findPreviewGroup(preview, overId)
    if (key != null) target = { key, index: preview[key].indexOf(overId) }
  }
  if (sourceKey == null || target == null || target.index < 0) return preview
  if (sourceKey === target.key) {
    const list = preview[sourceKey]
    const from = list.indexOf(activeId)
    if (from === target.index) return preview
    return { ...preview, [sourceKey]: arrayMove(list, from, target.index) }
  }
  const nextTarget = [...(preview[target.key] || [])]
  nextTarget.splice(target.index, 0, activeId)
  return {
    ...preview,
    [sourceKey]: preview[sourceKey].filter((id) => id !== activeId),
    [target.key]: nextTarget,
  }
}

// 空组/组间空隙的可放置容器；跨组拖动时挂在每个组外（SessionPanel）
export function SessionGroupDropZone({
  id,
  children,
  className,
}: {
  id: string
  children: ReactNode
  className?: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`${className ?? ''} ${isOver ? 'bg-accent/5' : ''}`}>
      {children}
    </div>
  )
}

// 纯 sortable 列表——必须在 DndContext 内使用（共享 context 才能跨组拖）
export function SessionSortableList({
  sessions,
  listClassName,
  getItemClassName,
  renderItem,
}: {
  sessions: Session[]
  listClassName?: string
  getItemClassName?: (args: GetClassNameArgs) => string
  renderItem: (args: RenderSessionArgs) => ReactNode
}) {
  const { active } = useDndContext()
  const activeId = active?.id ? String(active.id) : null
  return (
    <SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}>
      <div className={listClassName}>
        {sessions.map((session) => (
          <SortableSessionItem
            key={session.id}
            session={session}
            className={getItemClassName?.({ session, isDragging: activeId === session.id, isOverlay: false })}
            renderItem={renderItem}
          />
        ))}
      </div>
    </SortableContext>
  )
}

// 单列表自足封装（SessionRail / MobileDrawer）：自带 DndContext + 预览 + DragOverlay
export function SessionStandaloneSortableList({
  sessions,
  onMove,
  listClassName,
  getItemClassName,
  renderItem,
}: {
  sessions: Session[]
  onMove: (orderedSessionIds: string[]) => void
  listClassName?: string
  getItemClassName?: (args: GetClassNameArgs) => string
  renderItem: (args: RenderSessionArgs) => ReactNode
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [previewIds, setPreviewIds] = useState<string[]>([])
  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions])
  useEffect(() => {
    if (!activeId) setPreviewIds(sessionIds)
  }, [activeId, sessionIds])
  const sortedSessions = useMemo(() => orderByIds(sessions, previewIds), [previewIds, sessions])
  const activeSession = useMemo(() => sessions.find((session) => session.id === activeId) || null, [activeId, sessions])
  const handleDragStart = (event: DragStartEvent) => {
    const nextActiveId = String(event.active.id)
    setActiveId(nextActiveId)
    setPreviewIds(sessionIds)
  }
  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id ? String(event.over.id) : null
    const nextActiveId = event.active?.id ? String(event.active.id) : null
    if (!overId || !nextActiveId || overId === nextActiveId) return
    setPreviewIds((current) => {
      const activeIndex = current.indexOf(nextActiveId)
      const overIndex = current.indexOf(overId)
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return current
      return arrayMove(current, activeIndex, overIndex)
    })
  }
  const resetDrag = () => {
    setActiveId(null)
    setPreviewIds(sessionIds)
  }
  const handleDragEnd = (_event: DragEndEvent) => {
    if (previewIds.length && !arraysEqual(previewIds, sessionIds)) onMove(previewIds)
    resetDrag()
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
    >
      <SessionSortableList
        sessions={sortedSessions}
        listClassName={listClassName}
        getItemClassName={getItemClassName}
        renderItem={renderItem}
      />
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
        {activeSession ? (
          <div className={getItemClassName?.({ session: activeSession, isDragging: true, isOverlay: true })}>
            {renderItem({ session: activeSession, isDragging: true, isOverlay: true })}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
