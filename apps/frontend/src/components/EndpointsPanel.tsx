'use client'
import { useMemo, useState } from 'react'
import {
  FiCheck,
  FiChevronDown,
  FiChevronRight,
  FiCopy,
  FiExternalLink,
  FiRefreshCw,
  FiSearch,
  FiShare2,
  FiX,
} from 'react-icons/fi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useEndpoints, useHosts } from '@/hooks/useApi'
import { useClipboard } from '@/hooks/useClipboard'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import type { EndpointItem, EndpointSource } from '@/lib/api'

// 由 listen/name 推导可点 URL：通配地址（0.0.0.0/*/::）回退到主机可达地址
// （本机 127.0.0.1，远端取 SSH address）；拿不到时返回 null 只给原文复制
export function endpointUrl(item: EndpointItem, hostAddress?: string): string | null {
  const firstListen = item.listen.split(',')[0].trim()
  const loopback = hostAddress || null
  const parseAddr = (addr: string) => {
    const m = /^(.*):(\d+)$/.exec(addr)
    if (!m) return null
    const raw = m[1]
    const anyHost = ['0.0.0.0', '*', '::', '[::]', '::1', '[::1]', '127.0.0.1', 'localhost'].includes(raw)
    return { host: anyHost ? loopback : raw, port: m[2] }
  }
  if (item.source === 'nginx') {
    const port = /:(\d+)\s*$/.exec(firstListen)?.[1] || (/^\d+/.exec(firstListen)?.[0] ?? '')
    const ssl = /\bssl\b/.test(item.listen) || port === '443'
    const name = (item.name || '').split(/\s+/)[0]
    if (name && name !== '_' && !/[*~]/.test(name)) {
      const suffix = ssl ? (port === '443' ? '' : `:${port}`) : port === '80' || !port ? '' : `:${port}`
      return `${ssl ? 'https' : 'http'}://${name}${suffix}`
    }
    if (port && loopback) return `${ssl ? 'https' : 'http'}://${loopback}:${port}`
    return null
  }
  if (item.source === 'tailscale') {
    const parsed = parseAddr(firstListen.replace(/^https?:\/\//, ''))
    if (!parsed || !parsed.host) return null
    return `https://${parsed.host}${parsed.port === '443' ? '' : `:${parsed.port}`}`
  }
  const parsed = parseAddr(firstListen)
  if (!parsed || !parsed.host) return null
  return `${parsed.port === '443' ? 'https' : 'http'}://${parsed.host}:${parsed.port}`
}

// 端口 → 宿主端属主索引：把 target 里的 127.0.0.1:PORT 解析成最终实体
// （docker 容器 / 监听进程 / 另一层 nginx），回答「这个中继端口后面到底是什么」
export function buildOwnersByPort(endpoints: EndpointItem[]): Map<string, EndpointItem[]> {
  const map = new Map<string, EndpointItem[]>()
  for (const ep of endpoints) {
    for (const addr of ep.listen.split(',')) {
      const token = addr.trim()
      const port = /:(\d+)\s*$/.exec(token)?.[1] || /^\d+/.exec(token)?.[0]
      if (!port) continue
      const list = map.get(port) || []
      if (!list.includes(ep)) list.push(ep)
      map.set(port, list)
    }
  }
  return map
}

// 沿 target 的 host:port 递归找属主（上限 4 跳防环）；裸 ":port" 是容器内部口，不再解析
export function resolveChain(
  ownersByPort: Map<string, EndpointItem[]>,
  seen: Set<string>,
  target?: string,
): EndpointItem[] {
  const chain: EndpointItem[] = []
  let cur = target
  for (let depth = 0; depth < 4 && cur; depth++) {
    const m = /(?:^|\/\/)[^/:]+:(\d+)/.exec(cur)
    if (!m) break
    const owner = (ownersByPort.get(m[1]) || []).find((o) => !seen.has(o.id))
    if (!owner) break
    chain.push(owner)
    seen.add(owner.id)
    cur = owner.target
  }
  return chain
}

const ownerLabel = (o: EndpointItem) => [o.name, o.detail].filter((s) => s && s !== '?').join(' · ') || o.listen || '?'

export function chainLabel(chain: EndpointItem[]): string {
  if (!chain.length) return ''
  const last = chain[chain.length - 1]
  return chain.map(ownerLabel).join(' → ') + (last.target ? ` → ${last.target}` : '')
}

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

function EndpointRow({
  item,
  url,
  ownersByPort,
  expanded,
  onToggle,
}: {
  item: EndpointItem
  url: string | null
  ownersByPort: Map<string, EndpointItem[]>
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const { copy, copied } = useClipboard()
  const hasLocations = !!item.locations?.length
  const chainText = chainLabel(resolveChain(ownersByPort, new Set([item.id]), item.target))
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
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void copy(url || item.listen)}
            aria-label={url ? t('endpoints.copyUrl') : t('endpoints.copyListen')}
            title={url || item.listen}
            className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm text-text-3 hover:text-text-1"
          >
            {copied ? <FiCheck size={13} className="text-accent-2" /> : <FiCopy size={13} />}
          </button>
          {url && (
            <button
              type="button"
              onClick={() => window.open(url, '_blank', 'noopener')}
              aria-label={t('endpoints.openUrl')}
              title={url}
              className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm text-text-3 hover:text-text-1"
            >
              <FiExternalLink size={13} />
            </button>
          )}
        </span>
      </div>
      {(item.name || item.detail || chainText) && (
        <div className="mt-0.5 truncate pl-5 text-caption text-text-3" title={chainText || undefined}>
          {[item.name, item.detail].filter(Boolean).join(' · ')}
          {chainText && <span className="text-accent-2/70"> ⇒ {chainText}</span>}
        </div>
      )}
      {expanded && hasLocations && (
        <div className="mt-1 flex flex-col gap-0.5 border-l border-[var(--line)] pl-5">
          {item.locations!.map((loc, index) => {
            const locChain = loc.target ? chainLabel(resolveChain(ownersByPort, new Set([item.id]), loc.target)) : ''
            return (
              <div key={index} className="flex min-w-0 items-center gap-1.5 font-mono text-caption">
                <span className="shrink-0 text-text-2">{loc.path}</span>
                <span className="shrink-0 text-text-3">→</span>
                <span className="min-w-0 truncate text-text-3" title={locChain || undefined}>
                  {loc.target || loc.kind}
                  {locChain && <span className="text-accent-2/70"> ⇒ {locChain}</span>}
                </span>
              </div>
            )
          })}
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
  const { data: hosts } = useHosts()
  // 远端主机用其 SSH address 拼通配监听口的可达 URL；拿不到地址就退化为只复制原文
  const hostAddress = hostId === 'local' ? '127.0.0.1' : hosts?.find((h) => h.id === hostId)?.address
  const [query, setQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const ownersByPort = useMemo(() => buildOwnersByPort(data?.endpoints || []), [data])
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
                  url={endpointUrl(item, hostAddress)}
                  ownersByPort={ownersByPort}
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
