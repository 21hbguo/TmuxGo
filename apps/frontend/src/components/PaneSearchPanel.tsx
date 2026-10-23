'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { api } from '@/lib/api'
import { jumpToPaneSearchHit } from '@/lib/pane-search-jump'
import { isApplePlatform } from '@/lib/terminal-platform'
import type { PaneSearchHit, PaneSearchResponse } from '@/types'
import { ModalPortal } from './ModalPortal'

interface PaneSearchPanelProps {
  onClose: () => void
}

// 输入防抖：每敲一个字符就打一发 capture 会把 tmux server 和远端通道压满，
// 250ms 内的连续输入合并成一次请求
const DEBOUNCE_MS = 250
const DEFAULT_LINES = 1000

export function PaneSearchPanel({ onClose }: PaneSearchPanelProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<PaneSearchResponse | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { t } = useTranslation()
  const hostId = activeHostId || 'local'
  const sessionId = activeSessionId || ''

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 40)
    return () => clearTimeout(timer)
  }, [])

  // 搜索：防抖 + AbortController 丢弃过期响应（快打字时先发的请求可能后到）
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResult(null)
      setError('')
      setPending(false)
      return
    }
    if (!sessionId) {
      setError(t('paneSearch.noSession'))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setPending(true)
      api.paneSearch
        .run(hostId, sessionId, { query: trimmed, lines: DEFAULT_LINES }, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return
          setResult(response)
          setError(response.ok ? '' : t('paneSearch.failed'))
          setSelectedIndex(0)
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          setResult(null)
          setError(err instanceof Error && err.message ? err.message : t('paneSearch.failed'))
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, hostId, sessionId, t])

  const hits = useMemo(() => result?.hits || [], [result])
  const searched = result?.panes?.length || 0

  const jump = async (hit: PaneSearchHit) => {
    try {
      const outcome = await jumpToPaneSearchHit(hit, { lineFromEnd: hit.lineFromEnd })
      if (!outcome.scrolled) pushToast({ type: 'info', message: t('paneSearch.jumpedNoScroll') })
      onClose()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error && err.message ? err.message : t('paneSearch.failed') })
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 输入法合成中（中文/日文候选）不抢 ↑↓/Enter，否则选词会变成跳转
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (!hits.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((index) => (index + 1) % hits.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((index) => (index - 1 + hits.length) % hits.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[selectedIndex]
      if (hit) void jump(hit)
    }
  }

  // 选中项保持在可视区（键盘导航 + 长列表）
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const node = list.querySelector<HTMLElement>(`[data-hit-index="${selectedIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const mod = isApplePlatform() ? 'Cmd' : 'Ctrl'

  return (
    <ModalPortal modal onEscape={onClose}>
      <div className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim p-4" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-[640px] overflow-hidden rounded-apple border"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-label={t('paneSearch.title')}
        >
          <div className="flex items-center gap-2 p-3 border-b border-[var(--line)]">
            <span className="text-text-3 flex-shrink-0 text-sm">⌕</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('paneSearch.placeholder')}
              aria-label={t('paneSearch.placeholder')}
              className="flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3 text-sm"
            />
            {pending && <span className="text-text-3 text-xs">{t('paneSearch.searching')}</span>}
            <Button variant="ghost" size="icon-sm" className="flex-shrink-0" onClick={onClose} aria-label="close">
              ✕
            </Button>
          </div>
          <div className="px-3 py-1.5 text-[11px] text-text-3 border-b border-[var(--line)] flex items-center gap-3">
            <span>{mod}+Shift+F</span>
            <span>{t('paneSearch.navigate')}</span>
            <span>{t('paneSearch.select')}</span>
            {result && (
              <span className="ml-auto">
                {t('paneSearch.stats')
                  .replace('{panes}', String(searched))
                  .replace('{hits}', String(hits.length))
                  .replace('{lines}', String(result.maxLines))
                  .replace('{ms}', String(result.elapsedMs))}
              </span>
            )}
          </div>
          <div ref={listRef} className="tmuxgo-scrollbar max-h-[55vh] overflow-x-hidden overflow-y-auto">
            {error && <div className="px-3 py-6 text-text-3 text-sm text-center">{error}</div>}
            {!error && !query.trim() && (
              <div className="px-3 py-6 text-text-3 text-sm text-center">{t('paneSearch.hint')}</div>
            )}
            {!error && !!query.trim() && !pending && result && !hits.length && (
              <div className="px-3 py-6 text-text-3 text-sm text-center">{t('paneSearch.noResults')}</div>
            )}
            {hits.map((hit, index) => (
              <button
                key={`${hit.paneId}-${hit.line}`}
                data-hit-index={index}
                onClick={() => void jump(hit)}
                className={`w-full px-3 py-2 text-left flex flex-col gap-1 border-b border-[var(--line)]/40 transition-colors ${
                  index === selectedIndex ? 'bg-bg-2/60 text-text-1' : 'hover:bg-bg-2/40 text-text-2'
                }`}
              >
                <div className="flex items-center gap-2 text-[11px] text-text-3">
                  <span className="text-text-2">
                    {hit.windowIndex + 1}:{hit.paneIndex + 1} {hit.paneTitle}
                  </span>
                  <span>{t('paneSearch.line').replace('{line}', String(hit.lineFromEnd))}</span>
                </div>
                <div className="text-text-1 text-xs font-mono truncate">{hit.preview}</div>
              </button>
            ))}
            {result?.truncated && (
              <div className="px-3 py-2 text-text-3 text-[11px] text-center">{t('paneSearch.truncated')}</div>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
