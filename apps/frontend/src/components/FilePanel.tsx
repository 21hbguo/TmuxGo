'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFileList, useFilePreview, useFileRoots, useFileSearch } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FileContentMatch, FileItem, FileRoot } from '@/types'
import { writeClipboardText } from '@/lib/clipboard-text'
import { quoteShellPath } from '@/lib/path-drop'

type SearchMode = 'name' | 'content'
type RecentDirectory = { rootId: string; rootPath: string; name: string; path: string }
type FileEntry = FileItem | FileContentMatch

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}
function insertPath(path: string) {
  window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: quoteShellPath(path) } }))
}
function joinPath(base: string, name: string) {
  if (!name) return base
  if (!base || base === '/') return `/${name.replace(/^\/+/, '')}`
  return `${base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
}
function readRecentDirectories() {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem('tmuxgo-recent-directories') || '[]') as { rootId: string; rootPath: string; name: string; path: string }[]
  } catch {
    return []
  }
}
function writeRecentDirectory(entry: { rootId: string; rootPath: string; name: string; path: string }) {
  const next = [entry, ...readRecentDirectories().filter((item) => item.rootId !== entry.rootId || item.path !== entry.path)].slice(0, 3)
  localStorage.setItem('tmuxgo-recent-directories', JSON.stringify(next))
  return next
}
function readHideDotFiles() {
  if (typeof window === 'undefined') return true
  return localStorage.getItem('tmuxgo-hide-dot-files') !== 'false'
}
function writeHideDotFiles(value: boolean) {
  localStorage.setItem('tmuxgo-hide-dot-files', String(value))
}
function isDotPath(path: string) {
  return path.split(/[\\/]+/).some((part) => part.startsWith('.') && part.length > 1)
}
function FileIcon({ type }: { type: 'file' | 'directory' }) {
  return <span className={type === 'directory' ? 'text-accent' : 'text-text-3'}>{type === 'directory' ? '▸' : '·'}</span>
}
function getRootKind(root: FileRoot) {
  const label = root.label.toLowerCase()
  if (label === 'workspace') return 'workspace'
  if (label === 'home') return 'home'
  return 'other'
}
function getDirectoryName(path: string, root: FileRoot) {
  if (!path) return root.label
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || root.label
}
function formatRecentDirectoryLabel(path: string, rootLabel: string) {
  return `${rootLabel} · ${path || '/'}`
}
function TreeDirectoryNode({
  rootId,
  item,
  depth,
  hideDotFiles,
  selectedPath,
  onToggle,
  onSelectFile,
  onInsert,
  onContextMenu,
  openDirectories,
}: {
  rootId: string
  item: FileItem
  depth: number
  hideDotFiles: boolean
  selectedPath: string
  onToggle: (path: string) => void
  onSelectFile: (item: FileEntry) => void
  onInsert: (item: FileEntry) => void
  onContextMenu: (event: React.MouseEvent, item: FileEntry) => void
  openDirectories: Set<string>
}) {
  const isOpen = openDirectories.has(item.path)
  const { data: childList, isLoading } = useFileList(rootId, item.path, isOpen)
  const childItems = useMemo(() => {
    const nextItems = childList?.items || []
    return hideDotFiles ? nextItems.filter((entry) => !isDotPath(entry.path || entry.name)) : nextItems
  }, [childList, hideDotFiles])
  return (
    <div>
      <button
        tabIndex={0}
        onClick={() => onToggle(item.path)}
        onDoubleClick={() => onInsert(item)}
        onContextMenu={(e) => onContextMenu(e, item)}
        className={`group w-full border-l-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-2 ${selectedPath === item.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${isOpen ? 'text-accent' : 'text-text-3'}`}>{isOpen ? '▾' : '▸'}</span>
          <span className="text-accent">▸</span>
          <span className="min-w-0 flex-1 truncate font-mono text-text-1">{item.name}</span>
          <span className="text-[10px] text-text-3">dir</span>
        </div>
      </button>
      {isOpen && (
        <div>
          {isLoading && <div className="px-3 py-2 text-xs text-text-3" style={{ paddingLeft: `${28 + depth * 16}px` }}>Loading...</div>}
          {!isLoading && childItems.map((child) => (
            child.type === 'directory' ? (
              <TreeDirectoryNode
                key={child.path}
                rootId={rootId}
                item={child}
                depth={depth + 1}
                hideDotFiles={hideDotFiles}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
                onInsert={onInsert}
                onContextMenu={onContextMenu}
                openDirectories={openDirectories}
              />
            ) : (
              <button
                key={`${child.type}-${child.path}`}
                tabIndex={0}
                onClick={() => onSelectFile(child)}
                onDoubleClick={() => onInsert(child)}
                onContextMenu={(e) => onContextMenu(e, child)}
                className={`group w-full border-l-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-2 ${selectedPath === child.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
                style={{ paddingLeft: `${28 + (depth + 1) * 16}px` }}
              >
                <div className="flex items-center gap-2">
                  <FileIcon type={child.type} />
                  <span className="min-w-0 flex-1 truncate font-mono text-text-1">{child.name}</span>
                  <span className="text-[10px] text-text-3">{formatSize(child.size)}</span>
                </div>
              </button>
            )
          ))}
          {!isLoading && childItems.length === 0 && <div className="px-3 py-2 text-xs text-text-3" style={{ paddingLeft: `${28 + depth * 16}px` }}>Empty directory</div>}
        </div>
      )}
    </div>
  )
}

export function FilePanel({ mode = 'panel', onClose }: { mode?: 'panel' | 'mobile'; onClose?: () => void }) {
  const { filePanelWidth, setFilePanelWidth, setFilePanelOpen, pushToast } = useConsoleStore()
  const { data: roots = [] } = useFileRoots()
  const isMobile = mode === 'mobile'
  const [rootId, setRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileEntry } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list')
  const [recentDirectories, setRecentDirectories] = useState<RecentDirectory[]>([])
  const [contentReady, setContentReady] = useState(isMobile)
  const [hideDotFiles, setHideDotFiles] = useState(readHideDotFiles)
  const [openDirectories, setOpenDirectories] = useState<Set<string>>(new Set())
  const resizingRef = useRef(false)
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { data: listData, isLoading: listLoading } = useFileList(rootId, currentPath, true)
  const { data: preview } = useFilePreview(rootId, selectedPath)
  const { data: searchResults = [], isFetching: searchLoading } = useFileSearch(rootId, searchMode, query)
  const root = roots.find((item) => item.id === rootId)
  const rootLabelById = useMemo(() => Object.fromEntries(roots.map((item) => [item.id, item.label])), [roots])
  const quickRoots = useMemo(() => {
    const workspace = roots.find((item) => getRootKind(item) === 'workspace')
    const home = roots.find((item) => getRootKind(item) === 'home')
    return [workspace, home].filter(Boolean) as FileRoot[]
  }, [roots])
  const isSearching = query.trim().length > 1
  const items = useMemo(() => isSearching ? searchResults : listData?.items || [], [isSearching, searchResults, listData])
  const visibleItems = useMemo(() => hideDotFiles ? items.filter((item: any) => !isDotPath(item.path || item.name)) : items, [hideDotFiles, items])
  const visibleRecentDirectories = useMemo(() => hideDotFiles ? recentDirectories.filter((item) => !isDotPath(item.path)) : recentDirectories, [hideDotFiles, recentDirectories])

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [roots, rootId])
  useEffect(() => {
    setRecentDirectories(readRecentDirectories())
  }, [])
  useEffect(() => {
    if (isMobile) return
    const frame = requestAnimationFrame(() => setContentReady(true))
    return () => cancelAnimationFrame(frame)
  }, [isMobile])
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
  useEffect(() => {
    if (!root) return
    if (!currentPath) return
    setRecentDirectories(writeRecentDirectory({ rootId, rootPath: root.path, name: getDirectoryName(currentPath, root), path: currentPath }))
  }, [currentPath, root, rootId])

  const switchRoot = (nextRootId: string) => {
    setRootId(nextRootId)
    setCurrentPath('')
    setSelectedPath('')
    setQuery('')
    setMobileView('list')
    setOpenDirectories(new Set())
  }
  const openDirectoryShortcut = (entry: { rootId: string; path: string }) => {
    setRootId(entry.rootId)
    if (isMobile) setCurrentPath(entry.path)
    else setOpenDirectories(new Set(entry.path ? [entry.path] : []))
    setSelectedPath('')
    setQuery('')
    setMobileView('list')
  }
  const toggleDesktopDirectory = (path: string) => {
    setOpenDirectories((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openItem = (item: FileEntry) => {
    if (item.type === 'directory') {
      if (!isMobile) {
        toggleDesktopDirectory(item.path)
        return
      }
      setCurrentPath(item.path)
      setSelectedPath('')
      setQuery('')
      setMobileView('list')
      return
    }
    setSelectedPath(item.path)
    if (isMobile) setMobileView('preview')
  }
  const insertItemPath = (item: FileItem | FileContentMatch) => {
    const full = root ? joinPath(root.path, item.path) : item.path
    insertPath(full)
    pushToast({ type: 'success', message: `Inserted ${item.name}` })
  }
  const copyItemPath = async (item: FileItem | FileContentMatch) => {
    const full = root ? joinPath(root.path, item.path) : item.path
    const result = await writeClipboardText(full)
    if (!result.copied) {
      pushToast({ type: 'error', message: 'Copy failed' })
      return
    }
    pushToast({ type: 'success', message: result.unavailable ? 'Path copied in app' : 'Path copied' })
  }
  const selectFromKeyboard = (item: FileItem | FileContentMatch, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      insertItemPath(item)
    }
  }
  const updateHideDotFiles = (value: boolean) => {
    setHideDotFiles(value)
    writeHideDotFiles(value)
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
      <div className="text-text-2">Recent directories</div>
      {visibleRecentDirectories.length ? (
        <div className="mt-2 space-y-1">
          {visibleRecentDirectories.map((item) => (
            <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="block w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-[11px] text-text-2 hover:text-accent">{formatRecentDirectoryLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
          ))}
        </div>
      ) : (
        <div className="mt-2">Enter a directory from Workspace or Home to keep it here for quick return.</div>
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
      {!contentReady ? <div className="flex h-full items-center justify-center text-xs text-text-3">Loading...</div> : <>
      <div className="border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center gap-2">
          {isMobile && mobileView === 'preview' && <button onClick={() => setMobileView('list')} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2">‹</button>}
          <div className="text-sm font-semibold text-text-1">Files</div>
          <select value={rootId} onChange={(e) => switchRoot(e.target.value)} className="min-w-0 flex-1 rounded border border-[var(--line)] bg-bg-2 px-2 py-1 text-xs text-text-2 outline-none">
            {roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <button onClick={onClose || (() => setFilePanelOpen(false))} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2 hover:text-text-1">×</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {quickRoots.map((item) => (
            <button key={item.id} onClick={() => switchRoot(item.id)} className={`rounded px-2 py-1 text-[11px] ${rootId === item.id ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2 hover:text-text-1'}`}>{item.label}</button>
          ))}
          {visibleRecentDirectories.map((item) => (
            <button key={`recent-${item.rootId}-${item.path || 'root'}`} onClick={() => openDirectoryShortcut(item)} className="max-w-full truncate rounded bg-bg-2 px-2 py-1 text-[11px] text-text-3 hover:text-accent">{formatRecentDirectoryLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
          ))}
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
        <label className="mt-2 flex items-center justify-between rounded border border-[var(--line)] bg-bg-0 px-2 py-1.5 text-xs text-text-3">
          <span>Show dotfiles</span>
          <input type="checkbox" checked={!hideDotFiles} onChange={(e) => updateHideDotFiles(!e.target.checked)} className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
        </label>
      </div>}
      {(!isMobile || mobileView === 'list') && <div className="min-h-0 flex-1 overflow-y-auto">
        {isMobile && !isSearching && !currentPath && visibleRecentDirectories.length > 0 && (
          <div className="border-b border-[var(--line)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">Recent Directories</div>
            <div className="space-y-1">
              {visibleRecentDirectories.map((item) => (
                <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-xs text-text-2 active:text-accent">{formatRecentDirectoryLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
              ))}
            </div>
          </div>
        )}
        {(listLoading || searchLoading) && <div className="p-3 text-xs text-text-3">Loading...</div>}
        {!listLoading && visibleItems.map((item: any) => (
          !isMobile && !isSearching && item.type === 'directory' ? (
            <TreeDirectoryNode
              key={item.path}
              rootId={rootId}
              item={item}
              depth={0}
              hideDotFiles={hideDotFiles}
              selectedPath={selectedPath}
              onToggle={toggleDesktopDirectory}
              onSelectFile={openItem}
              onInsert={insertItemPath}
              onContextMenu={(e, entry) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, item: entry })
              }}
              openDirectories={openDirectories}
            />
          ) : (
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
          )
        ))}
        {!listLoading && !visibleItems.length && <div className="p-3 text-xs text-text-3">{isSearching ? 'No results' : 'Empty directory'}</div>}
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
      </>}
    </aside>
  )
}
