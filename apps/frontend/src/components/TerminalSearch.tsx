'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n'

interface TerminalSearchProps {
  terminal: any
  onClose: () => void
}

export function TerminalSearch({ terminal, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<number[]>([])
  const [currentResult, setCurrentResult] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const search = (term: string) => {
    setQuery(term)
    if (!terminal || !term) {
      setResults([])
      return
    }
    const searchAddon = terminal._addonManager?._addons?.find(
      (a: any) => a.instance?.findNext
    )?.instance
    if (searchAddon) {
      searchAddon.findNext(term, {})
      setResults([0])
      setCurrentResult(0)
    }
  }

  const navigateResult = (direction: number) => {
    if (!terminal) return
    const searchAddon = terminal._addonManager?._addons?.find(
      (a: any) => a.instance?.findNext
    )?.instance
    if (searchAddon) {
      if (direction > 0) {
        searchAddon.findNext(query, {})
      } else {
        searchAddon.findPrevious(query, {})
      }
    }
  }

  const handleFindNext = () => {
    navigateResult(1)
  }

  const handleFindPrevious = () => {
    navigateResult(-1)
  }

  return (
    <div className="absolute top-2 right-2 z-50 bg-bg-1 border border-[var(--line)] rounded-lg shadow-lg p-2 flex items-center gap-2" onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) {
          navigateResult(-1)
        } else {
          navigateResult(1)
        }
      }
    }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => search(e.target.value)}
        placeholder={t('terminalSearch.placeholder')}
        className="bg-bg-2 text-text-1 text-sm px-2 py-1 rounded outline-none w-48"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            if (e.shiftKey) {
              navigateResult(-1)
            } else {
              navigateResult(1)
            }
          }
        }}
      />
      <div className="flex items-center gap-1">
        <button
          onClick={handleFindPrevious}
          className="p-1 hover:bg-bg-2 rounded text-text-3"
        >
          ↑
        </button>
        <button
          onClick={handleFindNext}
          className="p-1 hover:bg-bg-2 rounded text-text-3"
        >
          ↓
        </button>
      </div>
      <button onClick={onClose} className="p-1 hover:bg-bg-2 rounded text-text-3">
        ×
      </button>
    </div>
  )
}
