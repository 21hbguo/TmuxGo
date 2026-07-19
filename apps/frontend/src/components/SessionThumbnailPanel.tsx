'use client'
import { useMemo } from 'react'
import { useSessionThumbnails } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { SessionThumbnailPane } from '@/types'

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
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const setSessionPanelExpanded = useConsoleStore((state) => state.setSessionPanelExpanded)
  const setThumbnailPanelOpen = useConsoleStore((state) => state.setThumbnailPanelOpen)
  const { data: orderedSessions = [] } = useOrderedSessions(activeHostId || '')
  const { data, isLoading, isFetching, isError, refetch } = useSessionThumbnails(activeHostId || '')
  const { t } = useTranslation()
  const thumbnails = useMemo(() => {
    const thumbnailById = new Map((data?.sessions || []).map((item) => [item.id, item]))
    return orderedSessions.map((session) => thumbnailById.get(session.id)).filter((item): item is NonNullable<typeof item> => !!item)
  }, [data?.sessions, orderedSessions])
  const selectSession = (sessionId: string) => {
    setActiveSession(sessionId)
    setThumbnailPanelOpen(false)
    setSessionPanelExpanded(true)
  }
  return <aside className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2">
      <div className="min-w-0 flex-1 text-sm font-semibold text-text-1">{t('thumbnail.title')}</div>
      <button title={t('thumbnail.refresh')} onClick={() => void refetch()} className={`flex h-7 w-7 items-center justify-center rounded text-xs ${isFetching ? 'text-accent' : 'text-text-3 hover:bg-bg-2 hover:text-text-1'}`}>↻</button>
      <button title={t('thumbnail.close')} onClick={() => setThumbnailPanelOpen(false)} className="flex h-7 w-7 items-center justify-center rounded text-sm text-text-3 hover:bg-bg-2 hover:text-text-1">×</button>
    </div>
    <div className="shrink-0 border-b border-[var(--line)] px-3 py-1.5 text-[10px] text-text-3">{isFetching ? t('thumbnail.refreshing') : t('thumbnail.live')}</div>
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
      {isLoading && <div className="p-2 text-xs text-text-3">{t('thumbnail.loading')}</div>}
      {isError && <div className="p-2 text-xs text-text-3">{t('thumbnail.unavailable')}</div>}
      {!isLoading && !isError && !thumbnails.length && <div className="p-2 text-xs text-text-3">{t('thumbnail.empty')}</div>}
      <div className="grid grid-cols-1 gap-2 min-[430px]:grid-cols-2">
        {thumbnails.map((thumbnail) => {
          const width = Math.max(1, ...thumbnail.panes.map((pane) => pane.left + pane.size.cols))
          const height = Math.max(1, ...thumbnail.panes.map((pane) => pane.top + pane.size.rows))
          const active = thumbnail.id === activeSessionId
          return <button key={thumbnail.id} title={thumbnail.name} onClick={() => selectSession(thumbnail.id)} className={`group overflow-hidden rounded border text-left transition-colors ${active ? 'border-accent bg-accent/10' : 'border-[var(--line)] bg-bg-0 hover:border-text-3 hover:bg-bg-2'}`}>
            <div className="flex h-7 items-center gap-2 border-b border-[var(--line)] px-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-text-3/50'}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-2 group-hover:text-text-1">{thumbnail.name}</span>
              <span className="shrink-0 text-[9px] text-text-3">{thumbnail.window?.name}</span>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden bg-[#080b0f]">
              {thumbnail.panes.map((pane) => <div key={pane.id} className={`absolute overflow-hidden border border-white/10 ${pane.active ? 'border-accent/50' : ''}`} style={paneStyle(pane, width, height)}>
                <pre className="m-0 min-h-full whitespace-pre p-1 font-mono text-[4px] leading-[6px] text-[#a8b6c7]">{pane.data || ' '}</pre>
              </div>)}
            </div>
          </button>
        })}
      </div>
    </div>
  </aside>
}
