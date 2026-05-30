'use client'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@/types'

type RenderSessionArgs = {
  session: Session
  isDragging: boolean
  isOverlay: boolean
}

type GetClassNameArgs = {
  session: Session
  isDragging: boolean
  isOverlay: boolean
}

function orderByIds(sessions: Session[], ids: string[]) {
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

function SortableSessionItem({ session, renderItem, className }: { session: Session; renderItem: (args: RenderSessionArgs) => ReactNode; className?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style} className={`touch-none select-none cursor-grab active:cursor-grabbing ${className ?? ''}`} {...attributes} {...listeners}>
      {renderItem({ session, isDragging, isOverlay: false })}
    </div>
  )
}

export function SessionSortableList({ sessions, onMove, listClassName, getItemClassName, renderItem }: { sessions: Session[]; onMove: (orderedSessionIds: string[]) => void; listClassName?: string; getItemClassName?: (args: GetClassNameArgs) => string; renderItem: (args: RenderSessionArgs) => ReactNode }) {
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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={resetDrag}>
      <SortableContext items={sortedSessions.map((session) => session.id)} strategy={verticalListSortingStrategy}>
        <div className={listClassName}>
          {sortedSessions.map((session) => <SortableSessionItem key={session.id} session={session} className={getItemClassName?.({ session, isDragging: activeId === session.id, isOverlay: false })} renderItem={renderItem} />)}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' }}>
        {activeSession ? <div className={getItemClassName?.({ session: activeSession, isDragging: true, isOverlay: true })}>{renderItem({ session: activeSession, isDragging: true, isOverlay: true })}</div> : null}
      </DragOverlay>
    </DndContext>
  )
}
