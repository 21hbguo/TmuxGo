'use client'
import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { ActivityBar } from './ActivityBar'
import { FilePanel } from './FilePanel'
import { SessionPanel } from './SessionPanel'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'

function getEditorLanguage(path: string) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name.endsWith('.ts')) return 'typescript'
  if (name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js')) return 'javascript'
  if (name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.sh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.go')) return 'go'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  return 'plaintext'
}

export function DesktopWorkbench() {
  const sidebarCollapsed = useConsoleStore((state) => state.sidebarCollapsed)
  const filePanelWidth = useConsoleStore((state) => state.filePanelWidth)
  const desktopPanel = useConsoleStore((state) => state.desktopPanel)
  const setFilePanelWidth = useConsoleStore((state) => state.setFilePanelWidth)
  const setDesktopPanel = useConsoleStore((state) => state.setDesktopPanel)
  const openEditor = useConsoleStore((state) => state.openEditor)
  const setEditorLoaded = useConsoleStore((state) => state.setEditorLoaded)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const resizingRef = useRef(false)
  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      setFilePanelWidth(event.clientX - 56)
    }
    const handleUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [setFilePanelWidth])
  const handleOpenFile = useCallback(async (file: FileDocumentHandle) => {
    setDesktopPanel('files')
    const existing = useConsoleStore.getState().openEditors.find((item) => item.id === file.id)
    openEditor({ ...file, language: existing?.language || getEditorLanguage(file.path) })
    if (existing && !existing.loading && (!!existing.modifiedAt || !!existing.problem || existing.binary || existing.truncated)) return
    try {
      const result = await api.files.content(file.rootId, file.path)
      setEditorLoaded(file.id, {
        loading: false,
        content: result.content,
        savedContent: result.content,
        modifiedAt: result.modifiedAt,
        size: result.size,
        binary: result.binary,
        truncated: result.truncated,
        problem: result.reason === 'large-file' ? 'Large files stay in preview mode for now.' : result.reason === 'binary-file' ? 'Binary files are not editable here.' : result.reason === 'directory' ? 'Directories cannot be opened in the editor.' : undefined,
      })
    } catch (err) {
      setEditorLoaded(file.id, { loading: false, problem: err instanceof Error ? err.message : 'Open failed' })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Open failed' })
    }
  }, [openEditor, pushToast, setDesktopPanel, setEditorLoaded])
  const handleSaveEditor = useCallback(async (editor: FileEditorDocument) => {
    if (editor.loading || editor.binary || editor.truncated) return
    setEditorSaving(editor.id, true)
    try {
      const result = await api.files.saveContent(editor.rootId, editor.path, editor.content, editor.modifiedAt || undefined)
      markEditorSaved(editor.id, result.content, result.modifiedAt, result.size)
      pushToast({ type: 'success', message: `${editor.name} saved` })
    } catch (err) {
      setEditorSaving(editor.id, false)
      const message = err instanceof Error ? err.message : 'Save failed'
      pushToast({ type: 'error', message })
    }
  }, [markEditorSaved, pushToast, setEditorSaving])
  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <ActivityBar />
      {!sidebarCollapsed && (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: filePanelWidth }}>
          <div className="h-full min-h-0">
            {desktopPanel === 'sessions' ? <SessionPanel /> : <FilePanel mode="explorer" onOpenFile={handleOpenFile} />}
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
        <div className="min-h-0 flex-1">
          <EditorWorkbench onSaveEditor={handleSaveEditor} />
        </div>
        <TerminalDock />
      </div>
    </div>
  )
}
