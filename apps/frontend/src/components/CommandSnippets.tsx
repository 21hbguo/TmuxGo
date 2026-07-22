'use client'

import { useState } from 'react'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { Chip } from './Chip'
import { useSnippets, SNIPPET_NAME_KEYS } from '@/hooks/useSnippets'
import { ModalPortal } from './ModalPortal'

interface CommandSnippetsProps {
  onSend: (command: string) => void
  onClose: () => void
}

export function CommandSnippets({ onSend, onClose }: CommandSnippetsProps) {
  const { snippets, addSnippet, removeSnippet } = useSnippets()
  const [search, setSearch] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [newSnippet, setNewSnippet] = useState({ name: '', command: '', description: '' })
  const { t } = useTranslation()

  const filtered = snippets.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.command.toLowerCase().includes(search.toLowerCase())
  )

  const handleAdd = () => {
    if (!newSnippet.name || !newSnippet.command) return
    addSnippet(newSnippet)
    setNewSnippet({ name: '', command: '', description: '' })
    setIsAdding(false)
  }

  const getSnippetName = (snippet: { id: string; name: string }) => {
    const nameKey = SNIPPET_NAME_KEYS[snippet.id]
    if (nameKey) return t(nameKey as any)
    return snippet.name
  }

  return <ModalPortal>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-apple w-full max-w-[500px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-text-1 text-lg font-medium">{t('snippets.title')}</h2>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="close">✕</Button>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snippets.search')}
            className="tmuxgo-control tmuxgo-input w-full rounded-apple px-3 py-2 text-sm"
          />
        </div>

        <div className="overflow-y-auto max-h-[50vh] p-2">
          {filtered.map((snippet) => (
            <div
              key={snippet.id}
              className="p-3 hover:bg-bg-2 rounded-apple cursor-pointer flex items-center justify-between group"
              onClick={() => {
                onSend(snippet.command)
                onClose()
              }}
            >
              <div>
                <div className="text-text-1 text-sm">{getSnippetName(snippet)}</div>
                <div className="text-text-3 text-xs font-mono mt-0.5">{snippet.command}</div>
              </div>
              <Chip
                tone="danger"
                onClick={(e) => {
                  e.stopPropagation()
                  removeSnippet(snippet.id)
                }}
                className="opacity-0 group-hover:opacity-100 px-2"
              >
                ×
              </Chip>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-[var(--line)]">
          {isAdding ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder={t('snippets.name')}
                value={newSnippet.name}
                onChange={(e) => setNewSnippet({ ...newSnippet, name: e.target.value })}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-3 py-2 text-sm"
              />
              <input
                type="text"
                placeholder={t('snippets.command')}
                value={newSnippet.command}
                onChange={(e) => setNewSnippet({ ...newSnippet, command: e.target.value })}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-3 py-2 font-mono text-sm"
              />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleAdd}>
                  {t('snippets.add')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
                  {t('snippets.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" className="w-full" onClick={() => setIsAdding(true)}>
              {t('snippets.addSnippet')}
            </Button>
          )}
        </div>
      </div>
    </div>
  </ModalPortal>
}
