'use client'
import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { ActivityBar } from './ActivityBar'
import { FilePanel } from './FilePanel'
import { SessionPanel } from './SessionPanel'
import { SessionRail } from './SessionRail'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'

function getEditorLanguage(path: string) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'plaintext'
  if (name.endsWith('.c')) return 'c'
  if (name.endsWith('.cc') || name.endsWith('.cpp') || name.endsWith('.cxx') || name.endsWith('.hpp') || name.endsWith('.h')) return 'cpp'
  if (name.endsWith('.ts')) return 'typescript'
  if (name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js')) return 'javascript'
  if (name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.mjs') || name.endsWith('.cjs')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.jsonc')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.scss')) return 'scss'
  if (name.endsWith('.less')) return 'less'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.xml') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.sh')) return 'shell'
  if (name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.go')) return 'go'
  if (name.endsWith('.java')) return 'java'
  if (name.endsWith('.kt')) return 'kotlin'
  if (name.endsWith('.rs')) return 'rust'
  if (name.endsWith('.php')) return 'php'
  if (name.endsWith('.rb')) return 'ruby'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.toml')) return 'ini'
  if (name.endsWith('.ini') || name.endsWith('.cfg') || name.endsWith('.conf')) return 'ini'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  return 'plaintext'
}

export function DesktopWorkbench() {
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const sessionPanelWidth = useConsoleStore((state) => state.sessionPanelWidth)
  const filePanelWidth = useConsoleStore((state) => state.filePanelWidth)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const setSessionPanelWidth = useConsoleStore((state) => state.setSessionPanelWidth)
  const setFilePanelWidth = useConsoleStore((state) => state.setFilePanelWidth)
  const setFilePanelOpen = useConsoleStore((state) => state.setFilePanelOpen)
  const openEditor = useConsoleStore((state) => state.openEditor)
  const setEditorLoaded = useConsoleStore((state) => state.setEditorLoaded)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const resizingRef = useRef<'session' | 'file' | null>(null)
  const restoredRef = useRef(false)
  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (resizingRef.current === 'session') {
        setSessionPanelWidth(event.clientX - 56)
        return
      }
      if (resizingRef.current === 'file') {
        const sessionOffset = 56 + (sessionPanelExpanded ? sessionPanelWidth : 16 * 4)
        setFilePanelWidth(event.clientX - sessionOffset)
      }
    }
    const handleUp = () => {
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [sessionPanelExpanded, sessionPanelWidth, setFilePanelWidth, setSessionPanelWidth])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'desktop-workbench', sessionPanelExpanded, sessionPanelWidth, filePanelOpen, filePanelWidth, editorsOpen: openEditors.length > 0 } }))
  }, [filePanelOpen, filePanelWidth, openEditors.length, sessionPanelExpanded, sessionPanelWidth])
  const handleOpenFile = useCallback(async (file: FileDocumentHandle) => {
    setFilePanelOpen(true)
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
  }, [openEditor, pushToast, setEditorLoaded, setFilePanelOpen])
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const editors = useConsoleStore.getState().openEditors
    if (!editors.length) return
    setFilePanelOpen(true)
    for (const editor of editors) void handleOpenFile(editor)
  }, [handleOpenFile, setFilePanelOpen])
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
      {sessionPanelExpanded ? (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: sessionPanelWidth }}>
          <div className="h-full min-h-0">
            <SessionPanel />
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = 'session'
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      ) : <SessionRail />}
      {filePanelOpen && (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: filePanelWidth }}>
          <div className="h-full min-h-0">
            <FilePanel mode="explorer" onOpenFile={handleOpenFile} />
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = 'file'
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
        {openEditors.length > 0 ? (
          <>
            <div className="min-h-0 flex-1">
              <EditorWorkbench onSaveEditor={handleSaveEditor} />
            </div>
            <TerminalDock />
          </>
        ) : (
          <div className="min-h-0 flex-1">
            <TerminalDock fill />
          </div>
        )}
      </div>
    </div>
  )
}
