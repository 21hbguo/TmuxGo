'use client'
import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { FilePanel } from './FilePanel'
import { PaneGrid } from './PaneGrid'
import { EditorWorkbench } from './EditorWorkbench'

function getEditorLanguage(path: string) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'javascript'
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

export function DesktopWorkspace() {
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const openEditor = useConsoleStore((state) => state.openEditor)
  const setEditorLoaded = useConsoleStore((state) => state.setEditorLoaded)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const setTerminalPanelHeight = useConsoleStore((state) => state.setTerminalPanelHeight)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const resizingRef = useRef(false)
  const hasEditor = openEditors.length > 0

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return
      setTerminalPanelHeight(window.innerHeight - event.clientY - 28)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'terminal-panel-resize' } }))
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
  }, [setTerminalPanelHeight])

  const handleOpenFile = useCallback(async (file: FileDocumentHandle) => {
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
  }, [openEditor, pushToast, setEditorLoaded])
  const handleSaveEditor = useCallback(async (editor: FileEditorDocument) => {
    if (editor.loading || editor.binary || editor.truncated) return
    setEditorSaving(editor.id, true)
    try {
      const result = await api.files.saveContent(editor.rootId, editor.path, editor.content, editor.modifiedAt || undefined)
      markEditorSaved(editor.id, result.content, result.modifiedAt, result.size)
      pushToast({ type: 'success', message: `${editor.name} saved` })
    } catch (err) {
      setEditorSaving(editor.id, false)
      pushToast({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' })
    }
  }, [markEditorSaved, pushToast, setEditorSaving])

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
        {!hasEditor ? (
          <div className="min-h-0 flex-1">
            <PaneGrid />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1">
              <EditorWorkbench onSaveEditor={handleSaveEditor} />
            </div>
            <section className="relative shrink-0 border-t border-[var(--line)] bg-bg-1" style={{ height: terminalPanelHeight }}>
              <div className="absolute left-0 right-0 top-0 z-10 h-1 cursor-row-resize hover:bg-accent/50" onMouseDown={() => {
                resizingRef.current = true
                document.body.style.cursor = 'row-resize'
                document.body.style.userSelect = 'none'
              }} />
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-3">Terminal</div>
                  <div className="text-[11px] text-text-3">{terminalPanelHeight}px</div>
                </div>
                <div className="min-h-0 flex-1">
                  <PaneGrid />
                </div>
              </div>
            </section>
          </>
        )}
      </div>
      {filePanelOpen && <FilePanel mode="panel" dock="right" onOpenFile={handleOpenFile} />}
    </div>
  )
}
