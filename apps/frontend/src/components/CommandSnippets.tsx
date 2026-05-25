'use client'

import { useState, useEffect } from 'react'

interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  category?: string
}

const defaultSnippets: Snippet[] = [
  { id: '1', name: 'List files', command: 'ls -la', category: 'basic' },
  { id: '2', name: 'Disk usage', command: 'df -h', category: 'system' },
  { id: '3', name: 'Memory usage', command: 'free -h', category: 'system' },
  { id: '4', name: 'Process list', command: 'ps aux | head -20', category: 'system' },
  { id: '5', name: 'Docker containers', command: 'docker ps', category: 'docker' },
  { id: '6', name: 'Git status', command: 'git status', category: 'git' },
  { id: '7', name: 'Git log', command: 'git log --oneline -10', category: 'git' },
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

  useEffect(() => {
    const stored = localStorage.getItem('tmuxgo-snippets')
    if (stored) {
      setSnippets(JSON.parse(stored))
    } else {
      setSnippets(defaultSnippets)
      localStorage.setItem('tmuxgo-snippets', JSON.stringify(defaultSnippets))
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[500px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-text-1 text-lg font-medium">Command Snippets</h2>
            <button onClick={onClose} className="text-text-3 hover:text-text-1">✕</button>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search snippets..."
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
                <div className="text-text-1 text-sm">{snippet.name}</div>
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
                placeholder="Name"
                value={newSnippet.name}
                onChange={(e) => setNewSnippet({ ...newSnippet, name: e.target.value })}
                className="w-full bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none"
              />
              <input
                type="text"
                placeholder="Command"
                value={newSnippet.command}
                onChange={(e) => setNewSnippet({ ...newSnippet, command: e.target.value })}
                className="w-full bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none font-mono"
              />
              <div className="flex gap-2">
                <button
                  onClick={addSnippet}
                  className="px-3 py-1.5 bg-accent text-bg-0 rounded text-sm"
                >
                  Add
                </button>
                <button
                  onClick={() => setIsAdding(false)}
                  className="px-3 py-1.5 bg-bg-2 text-text-2 rounded text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full px-3 py-2 bg-bg-2 rounded text-text-2 text-sm hover:bg-bg-1"
            >
              + Add Snippet
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
