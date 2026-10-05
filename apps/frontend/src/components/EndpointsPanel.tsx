'use client'
import { useMemo, useState } from 'react'
import { FiChevronDown, FiChevronRight, FiRefreshCw, FiSearch, FiShare2, FiX } from 'react-icons/fi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useEndpoints } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import type { EndpointItem, EndpointSource } from '@/lib/api'

const GROUP_ORDER: EndpointSource[] = ['nginx', 'tailscale', 'docker', 'socket']
const GROUP_LABEL_KEY: Record<EndpointSource, Parameters<ReturnType<typeof useTranslation>['t']>[0]> = {
  nginx: 'endpoints.group.nginx',
  tailscale: 'endpoints.group.tailscale',
  docker: 'endpoints.group.docker',
  socket: 'endpoints.group.socket',
}

interface EndpointsPanelProps {
  mode?: 'panel' | 'mobile'
  onClose?: () => void
}

function EndpointRow({ item, expanded, onToggle }: { item: EndpointItem; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  const hasLocations = !!item.locations?.length
  return (
    <div className="px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {hasLocations ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={t('endpoints.locations', { count: item.locations!.length })}
            className="shrink-0 text-text-3 hover:text-text-1"
          >
            {expanded ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />}
          </button>
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <span className="min-w-0 shrink font-mono text-xs text-text-1">{item.listen || '—'}</span>
        <span className="shrink-0 text-caption text-text-3">→</span>
        <span className="min-w-0 truncate font-mono text-xs text-accent-2">{item.target || item.name || '—'}</span>
      </div>
      {(item.name || item.detail) && (
        <div className="mt-0.5 truncate pl-5 text-caption text-text-3">
          {[item.name, item.detail].filter(Boolean).join(' · ')}
        </div>
      )}
      {expanded && hasLocations && (
        <div className="mt-1 flex flex-col gap-0.5 border-l border-[var(--line)] pl-5">
          {item.locations!.map((loc, index) => (
            <div key={index} className="flex min-w-0 items-center gap-1.5 font-mono text-caption">
              <span className="shrink-0 text-text-2">{loc.path}</span>
              <span className="shrink-0 text-text-3">→</span>
              <span className="min-w-0 truncate text-text-3">{loc.target || loc.kind}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function EndpointsPanel({ mode = 'panel', onClose }: EndpointsPanelProps) {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const hostId = activeHostId || 'local'
  const { data, isLoading, isError, isFetching, refetch } = useEndpoints(hostId)
  const [query, setQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (item: EndpointItem) =>
      !needle ||
      `${item.listen} ${item.name} ${item.target} ${item.detail || ''}`.toLowerCase().includes(needle) ||
      !!item.locations?.some((loc) => `${loc.path} ${loc.target}`.toLowerCase().includes(needle))
    return GROUP_ORDER.map((source) => ({
      source,
      items: (data?.endpoints || []).filter((item) => item.source === source && matches(item)),
    })).filter((group) => group.items.length > 0)
  }, [data, query])
  const toolbar = (
    <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
      <div className="relative min-w-0 flex-1">
        <FiSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-3" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('endpoints.searchPlaceholder')}
          className="w-full rounded-apple border border-[var(--line)] bg-bg-1 py-1.5 pl-7 pr-2 text-xs text-text-1 outline-none placeholder:text-text-3 focus:border-accent"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void refetch()}
        aria-label={t('common.refresh')}
        title={t('common.refresh')}
      >
        <FiRefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
      </Button>
    </div>
  )
  return (
    <section
      className={`tmuxgo-content-surface flex min-h-0 flex-col overflow-hidden ${mode === 'panel' ? 'shrink-0 border-r border-[var(--line)]' : 'h-full w-full'}`}
    >
      {mode === 'panel' && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2 text-accent">
            <FiShare2 size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-text-1">{t('endpoints.title')}</div>
            <div className="truncate text-caption text-text-3">{hostId}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <FiX size={15} />
          </Button>
        </header>
      )}
      {toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <div className="px-3 py-6 text-center text-xs text-text-3">…</div>}
        {isError && <div className="px-3 py-6 text-center text-xs text-text-3">{t('endpoints.loadError')}</div>}
        {data && !data.supported && (
          <div className="px-3 py-6 text-center text-xs text-text-3">{t('endpoints.unsupported')}</div>
        )}
        {data?.supported && groups.length === 0 && !isLoading && (
          <div className="px-3 py-6 text-center text-xs text-text-3">{t('endpoints.empty')}</div>
        )}
        {groups.map((group) => (
          <div key={group.source} className="border-b border-[var(--line)] last:border-0">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-meta font-semibold uppercase tracking-wide text-text-3">
              <span>{t(GROUP_LABEL_KEY[group.source])}</span>
              <span className="rounded-full bg-bg-2 px-1.5 py-0.5 text-caption">{group.items.length}</span>
            </div>
            <div className="divide-y divide-[var(--line)]/50">
              {group.items.map((item) => (
                <EndpointRow
                  key={item.id}
                  item={item}
                  expanded={!!expandedIds[item.id]}
                  onToggle={() => setExpandedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
