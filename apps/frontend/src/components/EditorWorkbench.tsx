'use client'
import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEditorDocument } from '@/types'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from '@/hooks/usePreferences'

const MonacoEditor=dynamic(() => import('@monaco-editor/react').then((mod) => mod.default), { ssr: false })

function getMonacoTheme(theme: string) {
  if (theme === 'light') return 'vs'
  if (theme === 'high-contrast') return 'hc-black'
  return 'vs-dark'
}
function getTabSize(language: string) {
  if (language === 'python' || language === 'yaml') return 4
  if (language === 'go') return 4
  return 2
}
function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
function applyInlineMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
}
function renderMarkdown(content: string) {
  const blocks = content.replace(/\r\n/g, '\n').split('\n')
  const html:string[] = []
  let paragraph:string[] = []
  let listItems:string[] = []
  let codeLines:string[] = []
  let codeLanguage = ''
  const flushParagraph = () => {
    if (!paragraph.length) return
    html.push(`<p>${applyInlineMarkdown(paragraph.join('<br />'))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!listItems.length) return
    html.push(`<ul>${listItems.map((item) => `<li>${applyInlineMarkdown(item)}</li>`).join('')}</ul>`)
    listItems = []
  }
  const flushCode = () => {
    if (!codeLines.length) return
    html.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${codeLines.join('\n')}</code></pre>`)
    codeLines = []
    codeLanguage = ''
  }
  for (const rawLine of blocks) {
    const line = escapeHtml(rawLine)
    if (rawLine.startsWith('```')) {
      flushParagraph()
      flushList()
      if (codeLines.length) {
        flushCode()
      } else {
        codeLanguage = rawLine.slice(3).trim()
      }
      continue
    }
    if (codeLanguage || codeLines.length) {
      codeLines.push(line)
      continue
    }
    if (!rawLine.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = rawLine.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${applyInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`)
      continue
    }
    const quote = rawLine.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      html.push(`<blockquote>${applyInlineMarkdown(escapeHtml(quote[1]))}</blockquote>`)
      continue
    }
    const list = rawLine.match(/^[-*]\s+(.*)$/)
    if (list) {
      flushParagraph()
      listItems.push(escapeHtml(list[1]))
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  flushCode()
  return html.join('')
}

export function EditorWorkbench({ onSaveEditor }:{ onSaveEditor: (editor: FileEditorDocument) => Promise<void> }) {
  const openEditors = useConsoleStore((state) => state.openEditors)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
  const setActiveEditor = useConsoleStore((state) => state.setActiveEditor)
  const closeEditor = useConsoleStore((state) => state.closeEditor)
  const setEditorContent = useConsoleStore((state) => state.setEditorContent)
  const { preferences } = usePreferences()
  const editorRef = useRef<any>(null)
  const [previewOpenById, setPreviewOpenById] = useState<Record<string, boolean>>({})
  const [cursorById, setCursorById] = useState<Record<string, { line: number; column: number }>>({})
  const activeEditor = openEditors.find((item) => item.id === activeEditorId) || openEditors[openEditors.length - 1] || null
  const markdownPreviewOpen = !!activeEditor && activeEditor.language === 'markdown' && !!previewOpenById[activeEditor.id]
  const cursor = activeEditor ? cursorById[activeEditor.id] : null
  const markdownPreview = useMemo(() => activeEditor?.language === 'markdown' ? renderMarkdown(escapeHtml(activeEditor.content)) : '', [activeEditor])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !activeEditor) return
      const target = event.target
      if (target instanceof Element && target.closest('[data-terminal],.xterm,.xterm-screen')) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!activeEditor.loading && !activeEditor.saving && !activeEditor.binary && !activeEditor.truncated) void onSaveEditor(activeEditor)
        return
      }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault()
        void editorRef.current?.getAction?.('editor.action.formatDocument')?.run?.()
        return
      }
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        if (activeEditor.dirty && !window.confirm(`Close ${activeEditor.name} without saving?`)) return
        closeEditor(activeEditor.id)
      }
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!activeEditor) return
      const nativeEvent = event as BeforeUnloadEvent & { ctrlKey?: boolean; metaKey?: boolean; key?: string }
      if (!(nativeEvent.ctrlKey || nativeEvent.metaKey) || nativeEvent.key?.toLowerCase() !== 'w') return
      event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('beforeunload', handleBeforeUnload, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('beforeunload', handleBeforeUnload, true)
    }
  }, [activeEditor, closeEditor, onSaveEditor])

  if (!activeEditor) return null

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-0">
      <div className="flex min-h-[42px] items-stretch overflow-x-auto border-b border-[var(--line)] bg-bg-1">
        {openEditors.map((editor) => (
          <div key={editor.id} className={`group flex h-[42px] w-44 shrink-0 items-center border-r border-[rgba(255,255,255,0.04)] ${editor.id === activeEditor.id ? 'bg-bg-0' : 'bg-bg-1/80'}`}>
            <button onClick={() => setActiveEditor(editor.id)} className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm ${editor.id === activeEditor.id ? 'text-text-1' : 'text-text-3 hover:text-text-1'}`}>
              <span className={`h-2 w-2 rounded-full ${editor.dirty ? 'bg-warn' : editor.saving ? 'bg-accent' : 'border border-[var(--line)] bg-transparent'}`} />
              <span className="min-w-0 flex-1 truncate">{editor.name}</span>
            </button>
            <button onClick={() => {
              if (editor.dirty && !window.confirm(`Close ${editor.name} without saving?`)) return
              closeEditor(editor.id)
            }} className="mr-2 shrink-0 rounded px-1.5 py-1 text-xs text-text-3 opacity-0 hover:bg-bg-2 hover:text-text-1 group-hover:opacity-100">×</button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.04)] bg-bg-1/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-text-1">{activeEditor.absolutePath}</div>
          <div className="mt-0.5 text-[11px] text-text-3">{activeEditor.language.toUpperCase()} · {activeEditor.size || 0}B{cursor ? ` · Ln ${cursor.line}, Col ${cursor.column}` : ''}{activeEditor.modifiedAt ? ` · ${new Date(activeEditor.modifiedAt).toLocaleString()}` : ''}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void editorRef.current?.getAction?.('actions.find')?.run?.()} className="rounded px-3 py-1.5 text-xs bg-bg-2 text-text-2 hover:text-text-1">Find</button>
          <button onClick={() => void editorRef.current?.getAction?.('editor.action.formatDocument')?.run?.()} className="rounded px-3 py-1.5 text-xs bg-bg-2 text-text-2 hover:text-text-1">Format</button>
          {activeEditor.language === 'markdown' && <button onClick={() => setPreviewOpenById((current) => ({ ...current, [activeEditor.id]: !current[activeEditor.id] }))} className={`rounded px-3 py-1.5 text-xs ${markdownPreviewOpen ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2 hover:text-text-1'}`}>Preview</button>}
          <button disabled={activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty} onClick={() => void onSaveEditor(activeEditor)} className={`rounded px-3 py-1.5 text-xs ${activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty ? 'bg-bg-2 text-text-3/50' : 'bg-accent/20 text-accent hover:text-text-1'}`}>{activeEditor.saving ? 'Saving...' : activeEditor.dirty ? 'Save' : 'Saved'}</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-bg-0">
        {activeEditor.loading ? <div className="flex h-full items-center justify-center text-sm text-text-3">Loading {activeEditor.name}...</div> : activeEditor.problem || activeEditor.binary || activeEditor.truncated ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-xl rounded-lg border border-[var(--line)] bg-bg-1 p-5">
              <div className="text-sm text-text-1">{activeEditor.name}</div>
              <div className="mt-2 text-sm text-text-3">{activeEditor.problem || (activeEditor.binary ? 'Binary files are not editable here.' : 'Large files open in preview only for now.')}</div>
            </div>
          </div>
        ) : (
          <div className={`flex h-full min-h-0 ${markdownPreviewOpen ? 'flex-row' : 'flex-col'}`}>
            <div className={`${markdownPreviewOpen ? 'min-w-0 flex-1 border-r border-[var(--line)]' : 'h-full'}`}>
              <MonacoEditor
                key={activeEditor.id}
                path={activeEditor.absolutePath}
                language={activeEditor.language}
                theme={getMonacoTheme(preferences.theme)}
                value={activeEditor.content}
                onMount={(editor) => {
                  editorRef.current = editor
                  const position = editor.getPosition?.()
                  if (position) setCursorById((current) => ({ ...current, [activeEditor.id]: { line: position.lineNumber, column: position.column } }))
                  editor.onDidChangeCursorPosition?.((event: any) => {
                    setCursorById((current) => ({ ...current, [activeEditor.id]: { line: event.position.lineNumber, column: event.position.column } }))
                  })
                }}
                onChange={(value) => setEditorContent(activeEditor.id, value || '')}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontFamily: preferences.fontFamily,
                  fontSize: Math.max(12, preferences.fontSize),
                  lineNumbers: 'on',
                  lineNumbersMinChars: 4,
                  glyphMargin: false,
                  folding: true,
                  foldingHighlight: true,
                  unfoldOnClickAfterEndOfLine: true,
                  guides: { indentation: true, bracketPairs: true },
                  bracketPairColorization: { enabled: true },
                  matchBrackets: 'always',
                  renderLineHighlight: 'line',
                  renderValidationDecorations: 'on',
                  occurrencesHighlight: 'singleFile',
                  selectionHighlight: true,
                  codeLens: false,
                  contextmenu: true,
                  links: true,
                  mouseWheelZoom: true,
                  cursorSmoothCaretAnimation: 'on',
                  scrollBeyondLastLine: false,
                  scrollbar: {
                    verticalScrollbarSize: 10,
                    horizontalScrollbarSize: 10,
                    alwaysConsumeMouseWheel: false,
                  },
                  overviewRulerBorder: false,
                  wordWrap: 'off',
                  wordWrapColumn: 120,
                  wrappingIndent: 'same',
                  tabSize: getTabSize(activeEditor.language),
                  insertSpaces: activeEditor.language !== 'go',
                  detectIndentation: true,
                  formatOnPaste: true,
                  formatOnType: true,
                  trimAutoWhitespace: true,
                  renderWhitespace: 'boundary',
                  renderControlCharacters: false,
                  smoothScrolling: true,
                  cursorBlinking: preferences.cursorBlink ? 'blink' : 'solid',
                  cursorStyle: 'line',
                  readOnlyMessage: { value: 'This file is read only.' },
                  padding: { top: 16, bottom: 16 },
                }}
              />
            </div>
            {markdownPreviewOpen && <div className="min-w-0 flex-1 overflow-auto bg-bg-1/60 px-6 py-5"><article className="prose prose-invert max-w-none text-sm text-text-2 [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--line)] [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:text-text-1 [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:text-text-1 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:text-text-1 [&_li]:mb-1 [&_p]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-bg-0 [&_pre]:p-4 [&_strong]:text-text-1" dangerouslySetInnerHTML={{ __html: markdownPreview || '<p>Nothing to preview.</p>' }} /></div>}
          </div>
        )}
      </div>
    </section>
  )
}
