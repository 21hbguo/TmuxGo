'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from './Button'
import { useTranslation } from '@/i18n'
import { isImeKeyEvent } from '@/lib/terminal-platform'

// SearchAddon 无法从 xterm 实例公开拿到，只能穿 _addonManager 私有结构找；
// 这里只声明用到的最小形状，xterm Terminal 本体可直接传入（全可选）
interface SearchAddonInstance {
  findNext?: (query: string, options?: object) => boolean
  findPrevious?: (query: string, options?: object) => boolean
}
interface TerminalSearchHost {
  _addonManager?: { _addons?: { instance?: SearchAddonInstance }[] }
}

interface TerminalSearchProps {
  terminal: TerminalSearchHost | null
  onClose: () => void
}

export function TerminalSearch({ terminal, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const search = (term: string) => {
    setQuery(term)
    if (!terminal || !term) return
    const searchAddon = terminal._addonManager?._addons?.find((a) => a.instance?.findNext)?.instance
    if (searchAddon) {
      searchAddon.findNext?.(term, {})
    }
  }

  const navigateResult = (direction: number) => {
    if (!terminal) return
    const searchAddon = terminal._addonManager?._addons?.find((a) => a.instance?.findNext)?.instance
    if (searchAddon) {
      if (direction > 0) {
        searchAddon.findNext?.(query, {})
      } else {
        searchAddon.findPrevious?.(query, {})
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
    <div
      className="absolute top-2 right-2 z-50 bg-bg-1 border border-[var(--line)] rounded-apple p-2 flex items-center gap-2"
      onKeyDown={(e) => {
        // IME 组字期按键交给输入法（input 内守卫未拦截时事件会冒泡至此）
        if (isImeKeyEvent(e.nativeEvent)) return
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
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => search(e.target.value)}
        placeholder={t('terminalSearch.placeholder')}
        className="tmuxgo-control tmuxgo-input w-48 rounded-apple px-2 py-1 text-sm"
        onKeyDown={(e) => {
          // IME 组字期按键交给输入法：选词 Enter/Escape 不得导航结果/关闭
          if (isImeKeyEvent(e.nativeEvent)) return
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
        <Button variant="ghost" size="icon-sm" onClick={handleFindPrevious} aria-label="previous">
          ↑
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={handleFindNext} aria-label="next">
          ↓
        </Button>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="close">
        ×
      </Button>
    </div>
  )
}
