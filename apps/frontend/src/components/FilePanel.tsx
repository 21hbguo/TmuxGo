'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFileList, useFilePreview, useFileRoots, useFileSearch } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FileContentMatch, FileItem } from '@/types'
import { quoteShellPath } from '@/lib/path-drop'

type SearchMode = 'name' | 'content'

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}
function insertPath(path: string) {
  window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: quoteShellPath(path) } }))
}
function joinPath(base: string, name: string) {
  return [base, name].filter(Boolean).join('/')
}
function readRecentFiles() {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem('tmuxgo-recent-files') || '[]') as { rootId: string; rootPath: string; name: string; path: string }[]
  } catch {
    return []
  }
}
function writeRecentFile(entry: { rootId: string; rootPath: string; name: string; path: string }) {
  const next = [entry, ...readRecentFiles().filter((item) => item.rootId !== entry.rootId || item.path !== entry.path)].slice(0, 8)
  localStorage.setItem('tmuxgo-recent-files', JSON.stringify(next))
  return next
}
function FileIcon({ type }: { type: 'file' | 'directory' }) {
  return <span className={type === 'directory' ? 'text-accent' : 'text-text-3'}>{type === 'directory' ? '▸' : '·'}</span>
}

export function FilePanel({ mode = 'panel', onClose }: { mode?: 'panel' | 'mobile'; onClose?: () => void }) {
  const { filePanelWidth, setFilePanelWidth, setFilePanelOpen, pushToast } = useConsoleStore()
  const { data: roots = [] } = useFileRoots()
  const [rootId, setRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem | FileContentMatch } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list')
  const [recentFiles, setRecentFiles] = useState<{ rootId: string; rootPath: string; name: string; path: string }[]>([])
  const resizingRef = useRef(false)
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMobile = mode === 'mobile'
  const { data: listData, isLoading: listLoading } = useFileList(rootId, currentPath)
  const { data: preview } = useFilePreview(rootId, selectedPath)
  const { data: searchResults = [], isFetching: searchLoading } = useFileSearch(rootId, searchMode, query)
  const root = roots.find((item) => item.id === rootId)
  const isSearching = query.trim().length > 1
  const items = useMemo(() => isSearching ? searchResults : listData?.items || [], [isSearching, searchResults, listData])

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [roots, rootId])
  useEffect(() => {
    setRecentFiles(readRecentFiles())
  }, [])
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      setFilePanelWidth(window.innerWidth - e.clientX)
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
  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const openItem = (item: FileItem | FileContentMatch) => {
    if (item.type === 'directory') {
      setCurrentPath(item.path)
      setSelectedPath('')
      setQuery('')
      setMobileView('list')
      return
    }
    setSelectedPath(item.path)
    if (root) setRecentFiles(writeRecentFile({ rootId, rootPath: root.path, name: item.name, path: item.path }))
    if (isMobile) setMobileView('preview')
  }
  const insertItemPath = (item: FileItem | FileContentMatch) => {
    const full = root ? joinPath(root.path, item.path) : item.path
    insertPath(full)
    if (root && item.type === 'file') setRecentFiles(writeRecentFile({ rootId, rootPath: root.path, name: item.name, path: item.path }))
    pushToast({ type: 'success', message: `Inserted ${item.name}` })
  }
  const copyItemPath = async (item: FileItem | FileContentMatch) => {
    const full = root ? joinPath(root.path, item.path) : item.path
    await navigator.clipboard.writeText(full)
    pushToast({ type: 'success', message: 'Path copied' })
  }
  const selectFromKeyboard = (item: FileItem | FileContentMatch, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      insertItemPath(item)
    }
  }
  const shellClass = isMobile ? 'flex h-full min-h-0 flex-col bg-bg-1' : 'relative flex h-full shrink-0 flex-col border-l border-[var(--line)] bg-bg-1'
  const shellStyle = isMobile ? undefined : { width: filePanelWidth }
  const previewBlock = preview ? (
    preview.binary || preview.reason ? (
      <div className="p-3 text-xs text-text-3">
        <div className="font-mono text-text-1">{preview.path}</div>
        <div className="mt-2">{preview.reason === 'large-file' ? 'Large file preview skipped' : preview.reason === 'binary-file' ? 'Binary file preview skipped' : 'Preview unavailable'}</div>
        <div className="mt-1">{formatSize(preview.size)}</div>
      </div>
    ) : (
      <div className="h-full overflow-auto p-2 font-mono text-[11px] leading-5">
        {preview.lines.map((line) => (
          <div key={line.number} className="grid grid-cols-[42px_1fr] gap-2">
            <span className="select-none text-right text-text-3">{line.number}</span>
            <span className="whitespace-pre text-text-2">{line.content || ' '}</span>
          </div>
        ))}
      </div>
    )
  ) : (
    <div className="p-3 text-xs text-text-3">
      <div className="text-text-2">Recent files</div>
      {recentFiles.length ? (
        <div className="mt-2 space-y-1">
          {recentFiles.map((item) => (
            <button key={`${item.rootId}-${item.path}`} onClick={() => { setRootId(item.rootId); setSelectedPath(item.path) }} className="block w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-[11px] text-text-2 hover:text-accent">{item.name}</button>
          ))}
        </div>
      ) : (
        <div className="mt-2">Select a file to preview. Double click or press Enter to insert its path.</div>
      )}
    </div>
  )

  return (
    <aside className={shellClass} style={shellStyle}>
      {!isMobile && (
        <div
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
          onMouseDown={() => {
            resizingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />
      )}
      <div className="border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center gap-2">
          {isMobile && mobileView === 'preview' && <button onClick={() => setMobileView('list')} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2">‹</button>}
          <div className="text-sm font-semibold text-text-1">Files</div>
          <select value={rootId} onChange={(e) => { setRootId(e.target.value); setCurrentPath(''); setSelectedPath('') }} className="min-w-0 flex-1 rounded border border-[var(--line)] bg-bg-2 px-2 py-1 text-xs text-text-2 outline-none">
            {roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <button onClick={onClose || (() => setFilePanelOpen(false))} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2 hover:text-text-1">×</button>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto text-xs text-text-3 scrollbar-none">
          {(listData?.breadcrumbs || [{ name: '/', path: '' }]).map((crumb) => (
            <button key={crumb.path || '/'} onClick={() => { setCurrentPath(crumb.path); setSelectedPath(''); setQuery('') }} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-2 hover:text-accent">{crumb.name}</button>
          ))}
        </div>
      </div>
      {(!isMobile || mobileView === 'list') && <div className="border-b border-[var(--line)] p-3">
        <div className="flex rounded border border-[var(--line)] bg-bg-2 p-0.5 text-xs">
          {(['name', 'content'] as SearchMode[]).map((item) => (
            <button key={item} onClick={() => setSearchMode(item)} className={`flex-1 rounded px-2 py-1 capitalize ${searchMode === item ? 'bg-accent/20 text-accent' : 'text-text-3 hover:text-text-1'}`}>{item}</button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchMode === 'name' ? 'Search file names' : 'Search file content'} className="mt-2 w-full rounded border border-[var(--line)] bg-bg-0 px-2 py-1.5 font-mono text-xs text-text-1 outline-none placeholder:text-text-3 focus:border-accent" />
      </div>}
      {(!isMobile || mobileView === 'list') && <div className="min-h-0 flex-1 overflow-y-auto">
        {isMobile && !isSearching && !currentPath && recentFiles.length > 0 && (
          <div className="border-b border-[var(--line)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">Recent</div>
            <div className="space-y-1">
              {recentFiles.map((item) => (
                <button key={`${item.rootId}-${item.path}`} onClick={() => { setRootId(item.rootId); setSelectedPath(item.path); setMobileView('preview') }} className="w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-xs text-text-2 active:text-accent">{item.name}</button>
              ))}
            </div>
          </div>
        )}
        {(listLoading || searchLoading) && <div className="p-3 text-xs text-text-3">Loading...</div>}
        {!listLoading && items.map((item: any) => (
          <button
            key={`${item.type}-${item.path}`}
            tabIndex={0}
            onClick={() => openItem(item)}
            onDoubleClick={() => insertItemPath(item)}
            onKeyDown={(e) => selectFromKeyboard(item, e)}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, item })
            }}
            onTouchStart={(e) => {
              if (!isMobile) return
              const touch = e.touches[0]
              if (!touch) return
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = setTimeout(() => setContextMenu({ x: touch.clientX, y: touch.clientY, item }), 520)
            }}
            onTouchMove={() => {
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = null
            }}
            onTouchEnd={() => {
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = null
            }}
            className={`group w-full border-l-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-2 ${selectedPath === item.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
          >
            <div className="flex items-center gap-2">
              <FileIcon type={item.type} />
              <span className="min-w-0 flex-1 truncate font-mono text-text-1">{item.name}</span>
              <span className="text-[10px] text-text-3">{item.type === 'file' ? formatSize(item.size) : 'dir'}</span>
            </div>
            {'matches' in item && item.matches?.[0] && <div className="mt-1 truncate pl-5 font-mono text-[10px] text-text-3">L{item.matches[0].number}: {item.matches[0].content}</div>}
          </button>
        ))}
        {!listLoading && !items.length && <div className="p-3 text-xs text-text-3">{isSearching ? 'No results' : 'Empty directory'}</div>}
      </div>}
      {(!isMobile || mobileView === 'preview') && <div className={isMobile ? 'min-h-0 flex-1 bg-bg-0' : 'max-h-[42%] min-h-[160px] border-t border-[var(--line)] bg-bg-0'}>{previewBlock}</div>}
      {isMobile && mobileView === 'preview' && selectedPath && <div className="border-t border-[var(--line)] p-3"><button onClick={() => insertPath(root ? joinPath(root.path, selectedPath) : selectedPath)} className="w-full rounded-lg bg-accent/20 px-3 py-3 text-sm text-accent active:scale-[0.98]">插入路径到终端</button></div>}
      {contextMenu && (
        <div className="fixed z-[90] w-40 overflow-hidden rounded border border-[var(--line)] bg-bg-1 py-1 text-xs shadow-lg" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { insertItemPath(contextMenu.item); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">Insert path</button>
          <button onClick={() => void copyItemPath(contextMenu.item).finally(() => setContextMenu(null))} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">Copy path</button>
          <button onClick={() => { setSelectedPath(contextMenu.item.path); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">Open preview</button>
        </div>
      )}
    </aside>
  )
}
