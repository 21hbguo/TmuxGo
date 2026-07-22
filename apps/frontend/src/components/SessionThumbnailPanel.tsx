'use client'
import { useEffect, useMemo, useState } from 'react'
import { useSessionThumbnails } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { SessionThumbnailPane } from '@/types'
import { PaneGrid } from './PaneGrid'

function paneStyle(pane: SessionThumbnailPane, width: number, height: number) {
  return {
    left: `${(pane.left / width) * 100}%`,
    top: `${(pane.top / height) * 100}%`,
    width: `${(pane.size.cols / width) * 100}%`,
    height: `${(pane.size.rows / height) * 100}%`,
  }
}

export function SessionThumbnailPanel() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setThumbnailPanelOpen = useConsoleStore((state) => state.setThumbnailPanelOpen)
  const { data: orderedSessions = [] } = useOrderedSessions(activeHostId || '')
  const { data, isLoading, isFetching, isError, refetch } = useSessionThumbnails(activeHostId || '')
  const { t } = useTranslation()
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const thumbnails = useMemo(() => {
    const thumbnailById = new Map((data?.sessions || []).map((item) => [item.id, item]))
    return orderedSessions.map((session) => thumbnailById.get(session.id)).filter((item): item is NonNullable<typeof item> => !!item)
  }, [data?.sessions, orderedSessions])
  const selectedThumbnail = thumbnails.find((item) => item.id === selectedSessionId) || null
  useEffect(() => {
    setSelectedSessionId((current) => thumbnails.some((item) => item.id === current) ? current : thumbnails.find((item) => item.id === activeSessionId)?.id || thumbnails[0]?.id || '')
  }, [activeSessionId, thumbnails])
  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
      <div className="min-w-0 flex-1 text-sm font-semibold text-text-1">{t('thumbnail.title')}</div>
      <button title={t('thumbnail.refresh')} onClick={() => void refetch()} className={`tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button ${isFetching ? 'text-accent' : ''}`}>↻</button>
      <button title={t('thumbnail.close')} onClick={() => setThumbnailPanelOpen(false)} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button">×</button>
    </div>
    <div className="shrink-0 border-b border-[var(--line)] px-3 py-1.5 text-[10px] text-text-3">{isFetching ? t('thumbnail.refreshing') : t('thumbnail.live')}</div>
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
      {isLoading && <div className="p-2 text-xs text-text-3">{t('thumbnail.loading')}</div>}
      {isError && <div className="p-2 text-xs text-text-3">{t('thumbnail.unavailable')}</div>}
      {!isLoading && !isError && !thumbnails.length && <div className="p-2 text-xs text-text-3">{t('thumbnail.empty')}</div>}
      {!!selectedThumbnail && <div className="mb-2 overflow-hidden rounded border border-accent bg-bg-0" data-testid="thumbnail-selected-card">
        <div className="flex h-8 items-center gap-2 border-b border-[var(--line)] px-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-1">{selectedThumbnail.name}</span>
          <span className="shrink-0 text-[10px] text-text-3">{selectedThumbnail.window?.name}</span>
        </div>
        <div className="h-[54vh] min-h-[320px] max-h-[680px]"><PaneGrid key={selectedThumbnail.id} sessionId={selectedThumbnail.id} /></div>
      </div>}
      <div className="grid grid-cols-1 gap-2 min-[720px]:grid-cols-2">
        {thumbnails.filter((thumbnail) => thumbnail.id !== selectedSessionId).map((thumbnail) => {
          const width = Math.max(1, ...thumbnail.panes.map((pane) => pane.left + pane.size.cols))
          const height = Math.max(1, ...thumbnail.panes.map((pane) => pane.top + pane.size.rows))
          return <button key={thumbnail.id} title={thumbnail.name} onClick={() => setSelectedSessionId(thumbnail.id)} className="group h-48 overflow-hidden rounded border border-[var(--line)] bg-bg-0 text-left transition-colors hover:border-accent hover:bg-bg-2">
            <div className="flex h-7 items-center gap-2 border-b border-[var(--line)] px-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-3/50 group-hover:bg-accent" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-2 group-hover:text-text-1">{thumbnail.name}</span>
              <span className="shrink-0 text-[9px] text-text-3">{thumbnail.window?.name}</span>
            </div>
            <div className="relative h-[calc(100%-1.75rem)] overflow-hidden bg-[#080b0f]">
              {thumbnail.panes.map((pane) => <div key={pane.id} className={`absolute overflow-hidden border border-white/10 ${pane.active ? 'border-accent/50' : ''}`} style={paneStyle(pane, width, height)}>
                <pre className="m-0 min-h-full whitespace-pre p-1 font-mono text-[4px] leading-[6px] text-[#a8b6c7]">{pane.data || ' '}</pre>
              </div>)}
            </div>
          </button>
        })}
      </div>
    </div>
  </section>
}
