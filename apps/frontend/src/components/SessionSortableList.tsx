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
import { ModalPortal } from './ModalPortal'

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
  // isOver 用 inset ring 而非纯 bg 染色：组头自身带 bg-bg-0/95，同优先级 bg 工具类
  // 层叠顺序不稳，ring 走 box-shadow 必定可见
  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ''} ${isOver ? 'bg-accent/5 ring-1 ring-inset ring-accent/50' : ''}`}
    >
      {children}
    </div>
  )
}

// 分组扁平列表——必须在 DndContext 内使用（共享 context 才能跨组拖）。
// 关键约束：所有 sortable 行与组头 dropzone 用 flatMap 铺成同一父容器下的
// 扁平 keyed 兄弟节点，使跨组预览移动 = 同父 DOM 搬移而非 unmount/remount；
// 若每组建独立包裹节点，被拖行在拖动中途被 React 重建，dnd-kit 的活动节点
// 引用失效（预览错乱、事件流断裂，drop 后内部状态残留导致无法再次拖动）。
export function SessionGroupedSortableList({
  groups,
  listClassName,
  getItemClassName,
  renderItem,
}: {
  groups: { key: string; header: ReactNode; sessions: Session[]; headerClassName?: string }[]
  listClassName?: string
  getItemClassName?: (args: GetClassNameArgs) => string
  renderItem: (args: RenderSessionArgs) => ReactNode
}) {
  const { active } = useDndContext()
  const activeId = active?.id ? String(active.id) : null
  const flatIds = useMemo(() => groups.flatMap((group) => group.sessions.map((session) => session.id)), [groups])
  return (
    <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
      <div className={listClassName}>
        {groups.flatMap((group) => [
          // 每组仅一个 group:key droppable。组头样式落在 dropzone 自身（不套内层 div）：
          // 扁平兄弟约束下 sticky 的包含块 = 整个列表，多个组头钉在 top-0 同一位置、
          // DOM 顺序后者盖前者 → 「当前组头钉顶」。若包一层只装组头的 div，sticky
          // 活动范围被压成 0。空组的 pb-5 只在拖拽激活时出现——平时是落点留白需求
          // 不存在，常驻会渲染出无底线收口的死空白。
          <SessionGroupDropZone
            key={`group-drop:${group.key || 'unclassified'}`}
            id={`group:${group.key}`}
            className={`${group.headerClassName ?? ''} ${group.sessions.length === 0 && activeId ? 'pb-5' : ''}`.trim()}
          >
            {group.header}
          </SessionGroupDropZone>,
          ...group.sessions.map((session) => (
            <SortableSessionItem
              key={session.id}
              session={session}
              className={getItemClassName?.({ session, isDragging: activeId === session.id, isOverlay: false })}
              renderItem={renderItem}
            />
          )),
        ])}
      </div>
    </SortableContext>
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
  onDragActiveChange,
  listClassName,
  getItemClassName,
  renderItem,
}: {
  sessions: Session[]
  onMove: (orderedSessionIds: string[]) => void
  onDragActiveChange?: (active: boolean) => void
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
    onDragActiveChange?.(true)
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
    onDragActiveChange?.(false)
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
      {/* DragOverlay 必须 portal 出容器：其内联渲染 position:fixed，落在带
          backdrop-filter/transform 的祖先（如玻璃面板、抽屉）内时 fixed 会相对
          该祖先解析而非视口，top 偏移到「非常下面」；dragOverlay.rect 亦随之测错
          污染碰撞检测 */}
      <ModalPortal>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
          {activeSession ? (
            <div className={getItemClassName?.({ session: activeSession, isDragging: true, isOverlay: true })}>
              {renderItem({ session: activeSession, isDragging: true, isOverlay: true })}
            </div>
          ) : null}
        </DragOverlay>
      </ModalPortal>
    </DndContext>
  )
}
