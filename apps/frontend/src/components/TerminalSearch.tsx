'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { Button } from './Button'
import { useTranslation } from '@/i18n'
import { isImeKeyEvent } from '@/lib/terminal-platform'
import { SEARCH_DECORATIONS, clearSearchHighlight, getSearchAddon } from '@/lib/terminal-search-addon'

interface TerminalSearchProps {
  terminal: Terminal | null
  onClose: () => void
}

export function TerminalSearch({ terminal, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  // resultIndex === -1 表示命中数超过 highlightLimit，addon 不再给精确下标
  const [results, setResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()
  const addon = getSearchAddon(terminal)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (!addon) return
    const sub = addon.onDidChangeResults((event: { resultIndex: number; resultCount: number }) => {
      setResults({ index: event.resultIndex, count: event.resultCount })
    })
    return () => sub.dispose()
  }, [addon])

  // 关掉面板时清掉高亮装饰和选中，否则终端里会留下一片找不到主人的色块
  const dispose = useCallback(() => {
    clearSearchHighlight(terminal)
  }, [terminal])

  useEffect(() => dispose, [dispose])

  // 大小写/整词都走 addon 原生选项，组件只负责把当前开关组合传下去。
  // overrides 用于「刚点了开关、state 还没重渲染」时按新值立刻重搜
  const searchOptions = (overrides: { caseSensitive?: boolean; wholeWord?: boolean } = {}) => ({
    caseSensitive: overrides.caseSensitive ?? caseSensitive,
    wholeWord: overrides.wholeWord ?? wholeWord,
    decorations: SEARCH_DECORATIONS,
    incremental: true,
  })

  const search = (term: string, direction: 1 | -1 = 1) => {
    if (!addon) return
    if (!term) {
      clearSearchHighlight(terminal)
      setResults({ index: -1, count: 0 })
      return
    }
    const options = { ...searchOptions(), incremental: direction > 0 }
    if (direction > 0) addon.findNext(term, options)
    else addon.findPrevious(term, options)
  }

  const handleChange = (term: string) => {
    setQuery(term)
    search(term, 1)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组字期按键交给输入法：选词 Enter/Escape 不得导航结果/关闭
    if (isImeKeyEvent(e.nativeEvent)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      handleClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      search(query, e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'F3') {
      e.preventDefault()
      e.stopPropagation()
      search(query, e.shiftKey ? -1 : 1)
    }
  }

  const handleClose = () => {
    dispose()
    onClose()
  }

  const counter = !query
    ? ''
    : results.count === 0
      ? t('terminalSearch.noResults')
      : results.index < 0
        ? `${results.count}+`
        : `${results.index + 1}/${results.count}`

  return (
    <div
      data-testid="terminal-search"
      data-terminal-overlay
      className="absolute top-2 right-2 z-50 flex items-center gap-2 rounded-apple border border-[var(--line)] bg-bg-1 p-2"
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={t('terminalSearch.placeholder')}
        aria-label={t('terminalSearch.placeholder')}
        className="tmuxgo-control tmuxgo-input w-48 rounded-apple px-2 py-1 text-sm"
        onKeyDown={handleKeyDown}
      />
      <span className="min-w-[3.5rem] text-right text-xs text-text-3" data-testid="terminal-search-counter">
        {counter}
      </span>
      <Button
        variant={caseSensitive ? 'accent' : 'ghost'}
        size="icon-sm"
        onClick={() => {
          const next = !caseSensitive
          setCaseSensitive(next)
          if (addon && query) addon.findNext(query, searchOptions({ caseSensitive: next }))
        }}
        aria-pressed={caseSensitive}
        aria-label={t('terminalSearch.caseSensitive')}
        title={t('terminalSearch.caseSensitive')}
      >
        Aa
      </Button>
      <Button
        variant={wholeWord ? 'accent' : 'ghost'}
        size="icon-sm"
        onClick={() => {
          const next = !wholeWord
          setWholeWord(next)
          if (addon && query) addon.findNext(query, searchOptions({ wholeWord: next }))
        }}
        aria-pressed={wholeWord}
        aria-label={t('terminalSearch.wholeWord')}
        title={t('terminalSearch.wholeWord')}
      >
        W
      </Button>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => search(query, -1)}
          aria-label={t('terminalSearch.previous')}
        >
          ↑
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => search(query, 1)} aria-label={t('terminalSearch.next')}>
          ↓
        </Button>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={handleClose} aria-label={t('terminalSearch.close')}>
        ×
      </Button>
    </div>
  )
}
