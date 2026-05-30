'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from '@/i18n'

interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  category?: string
}

const defaultSnippetCommands = [
  { id: '1', nameKey: 'snippets.listFiles' as const, command: 'ls -la', category: 'basic' },
  { id: '2', nameKey: 'snippets.diskUsage' as const, command: 'df -h', category: 'system' },
  { id: '3', nameKey: 'snippets.memoryUsage' as const, command: 'free -h', category: 'system' },
  { id: '4', nameKey: 'snippets.processList' as const, command: 'ps aux | head -20', category: 'system' },
  { id: '5', nameKey: 'snippets.dockerContainers' as const, command: 'docker ps', category: 'docker' },
  { id: '6', nameKey: 'snippets.gitStatus' as const, command: 'git status', category: 'git' },
  { id: '7', nameKey: 'snippets.gitLog' as const, command: 'git log --oneline -10', category: 'git' },
]

interface CommandSnippetsProps {
  onSend: (command: string) => void
  onClose: () => void
}

export function CommandSnippets({ onSend, onClose }: CommandSnippetsProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [search, setSearch] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [newSnippet, setNewSnippet] = useState({ name: '', command: '', description: '' })
  const { t } = useTranslation()

  useEffect(() => {
    const stored = localStorage.getItem('tmuxgo-snippets')
    if (stored) {
      setSnippets(JSON.parse(stored))
    } else {
      const defaults: Snippet[] = defaultSnippetCommands.map((s) => ({ id: s.id, name: s.nameKey, command: s.command, category: s.category }))
      setSnippets(defaults)
      localStorage.setItem('tmuxgo-snippets', JSON.stringify(defaults))
    }
  }, [])

  const filtered = snippets.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.command.toLowerCase().includes(search.toLowerCase())
  )

  const addSnippet = () => {
    if (!newSnippet.name || !newSnippet.command) return

    const snippet: Snippet = {
      id: Date.now().toString(),
      ...newSnippet,
    }

    const updated = [...snippets, snippet]
    setSnippets(updated)
    localStorage.setItem('tmuxgo-snippets', JSON.stringify(updated))
    setNewSnippet({ name: '', command: '', description: '' })
    setIsAdding(false)
  }

  const deleteSnippet = (id: string) => {
    const updated = snippets.filter((s) => s.id !== id)
    setSnippets(updated)
    localStorage.setItem('tmuxgo-snippets', JSON.stringify(updated))
  }

  const getSnippetName = (snippet: Snippet) => {
    const defaultEntry = defaultSnippetCommands.find((d) => d.id === snippet.id)
    if (defaultEntry) return t(defaultEntry.nameKey)
    return snippet.name
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[500px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-text-1 text-lg font-medium">{t('snippets.title')}</h2>
            <button onClick={onClose} className="text-text-3 hover:text-text-1">✕</button>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snippets.search')}
            className="w-full bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none"
          />
        </div>

        <div className="overflow-y-auto max-h-[50vh] p-2">
          {filtered.map((snippet) => (
            <div
              key={snippet.id}
              className="p-3 hover:bg-bg-2 rounded cursor-pointer flex items-center justify-between group"
              onClick={() => {
                onSend(snippet.command)
                onClose()
              }}
            >
              <div>
                <div className="text-text-1 text-sm">{getSnippetName(snippet)}</div>
                <div className="text-text-3 text-xs font-mono mt-0.5">{snippet.command}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSnippet(snippet.id)
                }}
                className="text-text-3 hover:text-danger opacity-0 group-hover:opacity-100"
              >
                ×
              </button>
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
                className="w-full bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none"
              />
              <input
                type="text"
                placeholder={t('snippets.command')}
                value={newSnippet.command}
                onChange={(e) => setNewSnippet({ ...newSnippet, command: e.target.value })}
                className="w-full bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none font-mono"
              />
              <div className="flex gap-2">
                <button
                  onClick={addSnippet}
                  className="px-3 py-1.5 bg-accent text-bg-0 rounded text-sm"
                >
                  {t('snippets.add')}
                </button>
                <button
                  onClick={() => setIsAdding(false)}
                  className="px-3 py-1.5 bg-bg-2 text-text-2 rounded text-sm"
                >
                  {t('snippets.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full px-3 py-2 bg-bg-2 rounded text-text-2 text-sm hover:bg-bg-1"
            >
              {t('snippets.addSnippet')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
