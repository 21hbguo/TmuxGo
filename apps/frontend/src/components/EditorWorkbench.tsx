'use client'
import dynamic from 'next/dynamic'
import { useEffect, useMemo } from 'react'
import type { FileEditorDocument } from '@/types'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from '@/hooks/usePreferences'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

function getEditorTheme(theme: string) {
  if (theme === 'light') return 'light'
  if (theme === 'high-contrast') return 'hc-black'
  return 'vs-dark'
}

export function EditorWorkbench({ onSaveEditor }:{ onSaveEditor: (editor: FileEditorDocument) => Promise<void> }) {
  const openEditors = useConsoleStore((state) => state.openEditors)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
  const setActiveEditor = useConsoleStore((state) => state.setActiveEditor)
  const closeEditor = useConsoleStore((state) => state.closeEditor)
  const setEditorContent = useConsoleStore((state) => state.setEditorContent)
  const { preferences } = usePreferences()
  const activeEditor = openEditors.find((item) => item.id === activeEditorId) || openEditors[openEditors.length - 1] || null
  const theme = useMemo(() => getEditorTheme(preferences.theme), [preferences.theme])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || !activeEditor) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-terminal],.xterm,.xterm-screen')) return
      event.preventDefault()
      if (!activeEditor.loading && !activeEditor.saving && !activeEditor.binary && !activeEditor.truncated) void onSaveEditor(activeEditor)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeEditor, onSaveEditor])
  if (!activeEditor) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-bg-0">
        <div className="flex h-full items-center justify-center">
          <div className="rounded-lg border border-[var(--line)] bg-bg-1 px-5 py-4 text-center">
            <div className="text-sm text-text-1">Open a file from Explorer</div>
            <div className="mt-1 text-xs text-text-3">Terminal stays docked below</div>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-0">
      <div className="flex min-h-[42px] items-stretch overflow-x-auto border-b border-[var(--line)] bg-bg-1">
        {openEditors.map((editor) => (
          <div key={editor.id} className={`group flex shrink-0 items-center border-r border-[rgba(255,255,255,0.04)] ${editor.id === activeEditor.id ? 'bg-bg-0' : 'bg-bg-1/80'}`}>
            <button onClick={() => setActiveEditor(editor.id)} className={`flex items-center gap-2 px-3 py-2 text-sm ${editor.id === activeEditor.id ? 'text-text-1' : 'text-text-3 hover:text-text-1'}`}>
              <span className={`h-2 w-2 rounded-full ${editor.dirty ? 'bg-warn' : editor.saving ? 'bg-accent' : 'bg-transparent border border-[var(--line)]'}`} />
              <span className="max-w-[220px] truncate">{editor.name}</span>
            </button>
            <button onClick={() => {
              if (editor.dirty && !window.confirm(`Close ${editor.name} without saving?`)) return
              closeEditor(editor.id)
            }} className="mr-2 rounded px-1.5 py-1 text-xs text-text-3 opacity-0 hover:bg-bg-2 hover:text-text-1 group-hover:opacity-100">×</button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.04)] bg-bg-1/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-text-1">{activeEditor.absolutePath}</div>
          <div className="mt-0.5 text-[11px] text-text-3">{activeEditor.language.toUpperCase()} · {activeEditor.size || 0}B{activeEditor.modifiedAt ? ` · ${new Date(activeEditor.modifiedAt).toLocaleString()}` : ''}</div>
        </div>
        <button disabled={activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty} onClick={() => void onSaveEditor(activeEditor)} className={`rounded px-3 py-1.5 text-xs ${activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty ? 'bg-bg-2 text-text-3/50' : 'bg-accent/20 text-accent hover:text-text-1'}`}>{activeEditor.saving ? 'Saving...' : activeEditor.dirty ? 'Save' : 'Saved'}</button>
      </div>
      <div className="min-h-0 flex-1 bg-bg-0">
        {activeEditor.loading ? <div className="flex h-full items-center justify-center text-sm text-text-3">Loading {activeEditor.name}...</div> : activeEditor.problem || activeEditor.binary || activeEditor.truncated ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-xl rounded-lg border border-[var(--line)] bg-bg-1 p-5">
              <div className="text-sm text-text-1">{activeEditor.name}</div>
              <div className="mt-2 text-sm text-text-3">{activeEditor.problem || (activeEditor.binary ? 'Binary files are not editable here.' : 'Large files open in preview only for now.')}</div>
            </div>
          </div>
        ) : <MonacoEditor path={activeEditor.id} language={activeEditor.language} theme={theme} value={activeEditor.content} onChange={(value) => setEditorContent(activeEditor.id, value ?? '')} options={{ minimap: { enabled: true }, fontSize: Math.max(12, preferences.fontSize), fontFamily: preferences.fontFamily, automaticLayout: true, scrollBeyondLastLine: false, wordWrap: 'off', tabSize: 2, insertSpaces: true, smoothScrolling: true, padding: { top: 16 }, renderLineHighlight: 'gutter' }} />}
      </div>
    </section>
  )
}
