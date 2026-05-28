'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFileList, useFilePreview, useFileRoots, useFileSearch } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FavoriteDirectory, FileContentMatch, FileItem, FileListResponse, FilePreviewResponse, FileRoot } from '@/types'
import { writeClipboardText } from '@/lib/clipboard-text'
import { quoteShellPath } from '@/lib/path-drop'
import { api } from '@/lib/api'

type SearchMode = 'name' | 'content'
type FileRootOption = FileRoot & { sourceRootId: string; basePath: string }
type FileEntry = FileItem | FileContentMatch
const FAVORITE_STORAGE_KEY = 'tmuxgo-favorite-directories'
const FAVORITE_UPDATED_AT_STORAGE_KEY = 'tmuxgo-favorite-directories-updated-at'
const PREFERENCES_PROFILE = 'default'

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
function joinRelativePath(base: string, name: string) {
  return `${base}/${name}`.split(/[\\/]+/).filter(Boolean).join('/')
}
function readFavoriteDirectories() {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITE_STORAGE_KEY) || '[]')
    return Array.isArray(stored) ? stored as FavoriteDirectory[] : []
  } catch {
    return []
  }
}
function readFavoriteDirectoriesUpdatedAt() {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(FAVORITE_UPDATED_AT_STORAGE_KEY) || ''
}
function writeFavoriteDirectories(entries: FavoriteDirectory[], updatedAt?: string) {
  const nextUpdatedAt = updatedAt || new Date().toISOString()
  localStorage.setItem(FAVORITE_STORAGE_KEY, JSON.stringify(entries))
  localStorage.setItem(FAVORITE_UPDATED_AT_STORAGE_KEY, nextUpdatedAt)
  return nextUpdatedAt
}
function toggleFavoriteDirectoryEntry(entry: FavoriteDirectory) {
  const current = readFavoriteDirectories()
  const exists = current.some((item) => item.rootId === entry.rootId && item.path === entry.path)
  const next = exists ? current.filter((item) => item.rootId !== entry.rootId || item.path !== entry.path) : [entry, ...current].slice(0, 12)
  const updatedAt = writeFavoriteDirectories(next)
  return { entries: next, updatedAt }
}
function removeFavoriteDirectoryEntry(entry: { rootId: string; path: string }) {
  const current = readFavoriteDirectories()
  const next = current.filter((item) => item.rootId !== entry.rootId || item.path !== entry.path)
  const updatedAt = writeFavoriteDirectories(next)
  return { entries: next, updatedAt }
}
function areFavoriteDirectoriesEqual(a: FavoriteDirectory[], b: FavoriteDirectory[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].rootId !== b[i].rootId || a[i].rootPath !== b[i].rootPath || a[i].name !== b[i].name || a[i].path !== b[i].path) return false
  }
  return true
}
function sanitizeFavoriteDirectories(entries: FavoriteDirectory[], roots: FileRoot[]) {
  const rootById = Object.fromEntries(roots.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const next: FavoriteDirectory[] = []
  for (const entry of entries) {
    const root = rootById[entry.rootId]
    if (!root) continue
    const normalizedPath = (entry.path || '').split(/[\\/]+/).filter(Boolean).join('/')
    if (normalizedPath.split('/').some((part) => part === '..')) continue
    const key = `${entry.rootId}:${normalizedPath}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push({
      rootId: entry.rootId,
      rootPath: root.path,
      name: entry.name || getDirectoryName(normalizedPath, root),
      path: normalizedPath,
    })
    if (next.length >= 12) break
  }
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
function formatDirectoryShortcutLabel(path: string, rootLabel: string) {
  return `${rootLabel} · ${path || '/'}`
}
function getFavoriteRootOptionId(entry: { rootId: string; path: string }) {
  return `favorite:${entry.rootId}:${encodeURIComponent(entry.path)}`
}
function parseFavoriteRootOptionId(value: string) {
  if (!value.startsWith('favorite:')) return null
  const tail = value.slice('favorite:'.length)
  const sep = tail.indexOf(':')
  if (sep < 0) return null
  const rootId = tail.slice(0, sep)
  const encodedPath = tail.slice(sep + 1)
  try {
    return { rootId, path: decodeURIComponent(encodedPath) }
  } catch {
    return null
  }
}
function getBreadcrumbs(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return [{ name: '/', path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))]
}
function getDirectoryPathChain(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
function stripBasePath(path: string, basePath: string) {
  const normalizedPath = path.split(/[\\/]+/).filter(Boolean).join('/')
  const normalizedBasePath = basePath.split(/[\\/]+/).filter(Boolean).join('/')
  if (!normalizedBasePath) return normalizedPath
  if (!normalizedPath || normalizedPath === normalizedBasePath) return ''
  const prefix = `${normalizedBasePath}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath
}
function rebaseEntryPath<T extends { path: string }>(entry: T, basePath: string) {
  const nextPath = stripBasePath(entry.path, basePath)
  return nextPath === entry.path ? entry : { ...entry, path: nextPath }
}
function rebaseListData(listData: FileListResponse | undefined, root: FileRootOption | undefined) {
  if (!listData || !root) return listData
  const nextPath = stripBasePath(listData.path, root.basePath)
  return { ...listData, root: { id: root.id, label: root.label, path: root.path }, path: nextPath, breadcrumbs: getBreadcrumbs(nextPath), items: listData.items.map((item) => rebaseEntryPath(item, root.basePath)) }
}
function rebasePreview(preview: FilePreviewResponse | undefined, basePath: string) {
  if (!preview) return preview
  return rebaseEntryPath(preview, basePath)
}
function getPreviewLine(item: FileEntry | null) {
  if (!item || !('matches' in item) || !item.matches?.length) return 1
  return Math.max(1, item.matches[0]?.number || 1)
}
function FavoriteDirectoryButton({ active, name, onClick }: { active: boolean; name: string; onClick: (event: React.MouseEvent) => void }) {
  return <button onClick={onClick} className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${active ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-text-1'}`} aria-label={`${active ? 'Unfavorite' : 'Favorite'} ${name}`}>{active ? '已收藏' : '收藏'}</button>
}
function TreeDirectoryNode({
  rootId,
  rootBasePath,
  item,
  depth,
  hideDotFiles,
  selectedPath,
  isFavoriteDirectory,
  onToggle,
  onToggleFavorite,
  onSelectFile,
  onInsert,
  onContextMenu,
  openDirectories,
}: {
  rootId: string
  rootBasePath: string
  item: FileItem
  depth: number
  hideDotFiles: boolean
  selectedPath: string
  isFavoriteDirectory: (entry: { rootId: string; path: string }) => boolean
  onToggle: (path: string) => void
  onToggleFavorite: (item: FileItem) => void
  onSelectFile: (item: FileEntry) => void
  onInsert: (item: FileEntry) => void
  onContextMenu: (event: React.MouseEvent, item: FileEntry) => void
  openDirectories: Set<string>
}) {
  const isOpen = openDirectories.has(item.path)
  const { data: childList, isLoading } = useFileList(rootId, joinRelativePath(rootBasePath, item.path), isOpen)
  const childItems = useMemo(() => {
    const nextItems = (childList?.items || []).map((entry) => rebaseEntryPath(entry, rootBasePath))
    return hideDotFiles ? nextItems.filter((entry) => !isDotPath(entry.path || entry.name)) : nextItems
  }, [childList, hideDotFiles, rootBasePath])
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
          <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId, path: joinRelativePath(rootBasePath, item.path) })} name={item.name} onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleFavorite(item)
          }} />
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
                rootBasePath={rootBasePath}
                item={child}
                depth={depth + 1}
                hideDotFiles={hideDotFiles}
                selectedPath={selectedPath}
                isFavoriteDirectory={isFavoriteDirectory}
                onToggle={onToggle}
                onToggleFavorite={onToggleFavorite}
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
function SearchDirectoryNode({
  rootId,
  rootBasePath,
  item,
  depth,
  hideDotFiles,
  searchMode,
  query,
  selectedPath,
  isFavoriteDirectory,
  onToggle,
  onToggleFavorite,
  onSelectFile,
  onInsert,
  onContextMenu,
  openDirectories,
}: {
  rootId: string
  rootBasePath: string
  item: FileItem
  depth: number
  hideDotFiles: boolean
  searchMode: SearchMode
  query: string
  selectedPath: string
  isFavoriteDirectory: (entry: { rootId: string; path: string }) => boolean
  onToggle: (path: string) => void
  onToggleFavorite: (item: FileItem) => void
  onSelectFile: (item: FileEntry) => void
  onInsert: (item: FileEntry) => void
  onContextMenu: (event: React.MouseEvent, item: FileEntry) => void
  openDirectories: Set<string>
}) {
  const isOpen = openDirectories.has(item.path)
  const searchPath = joinRelativePath(rootBasePath, item.path)
  const { data: rawChildResults = [], isFetching } = useFileSearch(rootId, searchMode, query, searchPath)
  const childItems = useMemo(() => {
    const nextItems = rawChildResults.map((entry) => rebaseEntryPath(entry, rootBasePath))
    return hideDotFiles ? nextItems.filter((entry: any) => !isDotPath(entry.path || entry.name)) : nextItems
  }, [rawChildResults, hideDotFiles, rootBasePath])
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
          <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId, path: joinRelativePath(rootBasePath, item.path) })} name={item.name} onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleFavorite(item)
          }} />
          <span className="text-[10px] text-text-3">dir</span>
        </div>
      </button>
      {isOpen && (
        <div>
          {isFetching && <div className="px-3 py-2 text-xs text-text-3" style={{ paddingLeft: `${28 + depth * 16}px` }}>Loading...</div>}
          {!isFetching && childItems.map((child: any) => (
            child.type === 'directory' ? (
              <SearchDirectoryNode
                key={child.path}
                rootId={rootId}
                rootBasePath={rootBasePath}
                item={child}
                depth={depth + 1}
                hideDotFiles={hideDotFiles}
                searchMode={searchMode}
                query={query}
                selectedPath={selectedPath}
                isFavoriteDirectory={isFavoriteDirectory}
                onToggle={onToggle}
                onToggleFavorite={onToggleFavorite}
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
                {'matches' in child && child.matches?.[0] && <div className="mt-1 truncate pl-5 font-mono text-[10px] text-text-3">L{child.matches[0].number}: {child.matches[0].content}</div>}
              </button>
            )
          ))}
          {!isFetching && childItems.length === 0 && <div className="px-3 py-2 text-xs text-text-3" style={{ paddingLeft: `${28 + depth * 16}px` }}>No results</div>}
        </div>
      )}
    </div>
  )
}

export function FilePanel({ mode = 'panel', onClose }: { mode?: 'panel' | 'mobile'; onClose?: () => void }) {
  const { filePanelWidth, setFilePanelWidth, setFilePanelOpen, openUploadDialog, pushToast } = useConsoleStore()
  const { data: roots = [] } = useFileRoots()
  const isMobile = mode === 'mobile'
  const [selectedRootId, setSelectedRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedPreviewLine, setSelectedPreviewLine] = useState(1)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileEntry } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list')
  const [favoriteDirectories, setFavoriteDirectories] = useState<FavoriteDirectory[]>([])
  const [contentReady, setContentReady] = useState(isMobile)
  const [hideDotFiles, setHideDotFiles] = useState(readHideDotFiles)
  const [openDirectories, setOpenDirectories] = useState<Set<string>>(new Set())
  const resizingRef = useRef(false)
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const virtualRoots = useMemo(() => favoriteDirectories.map((item) => ({ id: getFavoriteRootOptionId(item), label: item.name, path: joinPath(item.rootPath, item.path), sourceRootId: item.rootId, basePath: item.path })), [favoriteDirectories])
  const rootOptions = useMemo(() => [...roots.map((item) => ({ ...item, sourceRootId: item.id, basePath: '' })), ...virtualRoots], [roots, virtualRoots])
  const activeRoot = rootOptions.find((item) => item.id === selectedRootId) || rootOptions[0]
  const activeRootId = activeRoot?.sourceRootId || ''
  const activeRootBasePath = activeRoot?.basePath || ''
  const activeFavorite = useMemo(() => {
    const parsed = parseFavoriteRootOptionId(selectedRootId)
    if (!parsed) return null
    return favoriteDirectories.find((item) => item.rootId === parsed.rootId && item.path === parsed.path) || null
  }, [favoriteDirectories, selectedRootId])
  const listQueryPath = joinRelativePath(activeRootBasePath, currentPath)
  const previewQueryPath = joinRelativePath(activeRootBasePath, selectedPath)
  const { data: rawListData, isLoading: listLoading } = useFileList(activeRootId, listQueryPath, true)
  const { data: rawPreview } = useFilePreview(activeRootId, previewQueryPath, selectedPreviewLine)
  const searchBasePath = joinRelativePath(activeRootBasePath, currentPath)
  const { data: rawSearchResults = [], isFetching: searchLoading } = useFileSearch(activeRootId, searchMode, query, searchBasePath)
  const root = activeRoot
  const listData = useMemo(() => rebaseListData(rawListData, activeRoot), [rawListData, activeRoot])
  const preview = useMemo(() => rebasePreview(rawPreview, activeRootBasePath), [rawPreview, activeRootBasePath])
  const searchResults = useMemo(() => rawSearchResults.map((item) => rebaseEntryPath(item, activeRootBasePath)), [rawSearchResults, activeRootBasePath])
  const rootLabelById = useMemo(() => Object.fromEntries(roots.map((item) => [item.id, item.label])), [roots])
  const quickRoots = useMemo(() => {
    const workspace = roots.find((item) => getRootKind(item) === 'workspace')
    const home = roots.find((item) => getRootKind(item) === 'home')
    return [workspace, home].filter(Boolean) as FileRoot[]
  }, [roots])
  const isSearching = query.trim().length > 1
  const items = useMemo(() => isSearching ? searchResults : listData?.items || [], [isSearching, searchResults, listData])
  const visibleItems = useMemo(() => hideDotFiles ? items.filter((item: any) => !isDotPath(item.path || item.name)) : items, [hideDotFiles, items])
  const visibleFavoriteDirectories = useMemo(() => hideDotFiles ? favoriteDirectories.filter((item) => !isDotPath(item.path)) : favoriteDirectories, [hideDotFiles, favoriteDirectories])

  useEffect(() => {
    if (!selectedRootId && rootOptions[0]) setSelectedRootId(rootOptions[0].id)
  }, [rootOptions, selectedRootId])
  useEffect(() => {
    if (!selectedRootId) return
    if (rootOptions.some((item) => item.id === selectedRootId)) return
    setSelectedRootId(rootOptions[0]?.id || '')
  }, [rootOptions, selectedRootId])
  useEffect(() => {
    if (!roots.length) return
    const localEntries = readFavoriteDirectories()
    const sanitizedLocalEntries = sanitizeFavoriteDirectories(localEntries, roots)
    if (!areFavoriteDirectoriesEqual(localEntries, sanitizedLocalEntries)) writeFavoriteDirectories(sanitizedLocalEntries)
    setFavoriteDirectories(sanitizedLocalEntries)
    const localUpdatedAt = readFavoriteDirectoriesUpdatedAt()
    void (async () => {
      try {
        const remote = await api.preferences.get(PREFERENCES_PROFILE)
        const remoteEntriesRaw = Array.isArray(remote.favoriteDirectories) ? remote.favoriteDirectories : []
        const remoteEntries = sanitizeFavoriteDirectories(remoteEntriesRaw, roots)
        const remoteUpdatedAt = remote.favoriteDirectoriesUpdatedAt || ''
        const localMs = Date.parse(localUpdatedAt || '')
        const remoteMs = Date.parse(remoteUpdatedAt || '')
        if (remoteEntries.length === 0 && sanitizedLocalEntries.length > 0) {
          const pushedAt = localUpdatedAt || new Date().toISOString()
          await api.preferences.update({ favoriteDirectories: sanitizedLocalEntries, favoriteDirectoriesUpdatedAt: pushedAt }, PREFERENCES_PROFILE)
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          writeFavoriteDirectories(remoteEntries, remoteUpdatedAt || new Date().toISOString())
          setFavoriteDirectories(remoteEntries)
          if (!areFavoriteDirectoriesEqual(remoteEntriesRaw, remoteEntries)) await api.preferences.update({ favoriteDirectories: remoteEntries, favoriteDirectoriesUpdatedAt: remoteUpdatedAt || new Date().toISOString() }, PREFERENCES_PROFILE)
          return
        }
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
          await api.preferences.update({ favoriteDirectories: sanitizedLocalEntries, favoriteDirectoriesUpdatedAt: localUpdatedAt }, PREFERENCES_PROFILE)
        }
      } catch {}
    })()
  }, [roots])
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
  const switchRoot = (nextRootId: string) => {
    setSelectedRootId(nextRootId)
    setCurrentPath('')
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setQuery('')
    setMobileView('list')
    setOpenDirectories(new Set())
  }
  const openDirectoryShortcut = (entry: { rootId: string; path: string }) => {
    const nextRootId = getFavoriteRootOptionId(entry)
    setSelectedRootId(nextRootId)
    if (isMobile) setCurrentPath('')
    else setOpenDirectories(new Set())
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setQuery('')
    setMobileView('list')
  }
  const isFavoriteDirectory = (entry: { rootId: string; path: string }) => favoriteDirectories.some((item) => item.rootId === entry.rootId && item.path === entry.path)
  const toggleFavoriteDirectory = (item: FileItem) => {
    if (!root) return
    const nextRootId = activeRoot?.sourceRootId || ''
    const nextRootPath = roots.find((entry) => entry.id === nextRootId)?.path || root.path
    const nextPath = joinRelativePath(activeRootBasePath, item.path)
    const nextName = getDirectoryName(nextPath, { ...root, path: nextRootPath })
    const next = toggleFavoriteDirectoryEntry({ rootId: nextRootId, rootPath: nextRootPath, name: nextName, path: nextPath })
    setFavoriteDirectories(next.entries)
    void api.preferences.update({ favoriteDirectories: next.entries, favoriteDirectoriesUpdatedAt: next.updatedAt }, PREFERENCES_PROFILE).catch(() => {})
  }
  const removeFavoriteDirectory = (entry: { rootId: string; path: string }) => {
    const next = removeFavoriteDirectoryEntry(entry)
    setFavoriteDirectories(next.entries)
    void api.preferences.update({ favoriteDirectories: next.entries, favoriteDirectoriesUpdatedAt: next.updatedAt }, PREFERENCES_PROFILE).catch(() => {})
    if (selectedRootId === getFavoriteRootOptionId(entry)) switchRoot(entry.rootId)
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
      setSelectedPreviewLine(1)
      setMobileView('list')
      return
    }
    setSelectedPath(item.path)
    setSelectedPreviewLine(getPreviewLine(item))
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
  const handleUploadSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || [])
    if (!selectedFiles.length) return
    openUploadDialog({ files: selectedFiles, preferredRootId: activeRootId, preferredPath: listQueryPath, insertPaths: true })
    event.target.value = ''
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
      <div className="text-text-2">Favorite directories</div>
      {visibleFavoriteDirectories.length ? (
        <div className="mt-2 space-y-1">
          {visibleFavoriteDirectories.map((item) => (
            <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="block w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-[11px] text-text-2 hover:text-accent">{formatDirectoryShortcutLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
          ))}
        </div>
      ) : (
        <div className="mt-2">收藏目录后会显示在这里，方便从 Workspace 或 Home 快速返回。</div>
      )}
    </div>
  )

  return (
    <aside className={shellClass} style={shellStyle}>
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadSelect} />
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
          <select value={selectedRootId} onChange={(e) => switchRoot(e.target.value)} className="min-w-0 flex-1 rounded border border-[var(--line)] bg-bg-2 px-2 py-1 text-xs text-text-2 outline-none">
            {rootOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <button onClick={() => uploadInputRef.current?.click()} className="rounded px-2 py-1 text-[11px] text-accent hover:bg-bg-2">上传</button>
          {activeFavorite && <button onClick={() => removeFavoriteDirectory(activeFavorite)} className="rounded px-2 py-1 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1">删收藏</button>}
          <button onClick={onClose || (() => setFilePanelOpen(false))} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2 hover:text-text-1">×</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {quickRoots.map((item) => (
            <button key={item.id} onClick={() => switchRoot(item.id)} className={`rounded px-2 py-1 text-[11px] ${selectedRootId === item.id ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2 hover:text-text-1'}`}>{item.label}</button>
          ))}
          {visibleFavoriteDirectories.map((item) => (
            <button key={`favorite-${item.rootId}-${item.path || 'root'}`} onClick={() => openDirectoryShortcut(item)} className={`max-w-full truncate rounded px-2 py-1 text-[11px] ${selectedRootId === getFavoriteRootOptionId(item) ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-accent'}`}>{formatDirectoryShortcutLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
          ))}
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto text-xs text-text-3 scrollbar-none">
          {(listData?.breadcrumbs || [{ name: '/', path: '' }]).map((crumb) => (
            <button key={crumb.path || '/'} onClick={() => { setCurrentPath(crumb.path); setSelectedPath(''); setSelectedPreviewLine(1); setQuery('') }} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-2 hover:text-accent">{crumb.name}</button>
          ))}
        </div>
      </div>
      {(!isMobile || mobileView === 'list') && <div className="border-b border-[var(--line)] p-3">
        <div className="flex rounded border border-[var(--line)] bg-bg-2 p-0.5 text-xs">
          {(['name', 'content'] as SearchMode[]).map((item) => (
            <button key={item} onClick={() => setSearchMode(item)} className={`flex-1 rounded px-2 py-1 capitalize ${searchMode === item ? 'bg-accent/20 text-accent' : 'text-text-3 hover:text-text-1'}`}>{item}</button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchMode === 'name' ? 'Search file names' : 'Search file content'} className="min-w-0 flex-1 rounded border border-[var(--line)] bg-bg-0 px-2 py-1.5 font-mono text-xs text-text-1 outline-none placeholder:text-text-3 focus:border-accent" />
          <button onClick={() => setQuery('')} disabled={!query} aria-label="Clear search" className={`shrink-0 rounded border border-[var(--line)] px-2 py-1.5 text-xs ${query ? 'bg-bg-2 text-text-2 hover:text-accent' : 'bg-bg-0 text-text-3/40'}`}>×</button>
        </div>
        <label className="mt-2 flex items-center justify-between rounded border border-[var(--line)] bg-bg-0 px-2 py-1.5 text-xs text-text-3">
          <span>Show dotfiles</span>
          <input type="checkbox" checked={!hideDotFiles} onChange={(e) => updateHideDotFiles(!e.target.checked)} className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
        </label>
      </div>}
      {(!isMobile || mobileView === 'list') && <div className="min-h-0 flex-1 overflow-y-auto">
        {isMobile && !isSearching && !currentPath && visibleFavoriteDirectories.length > 0 && (
          <div className="border-b border-[var(--line)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">Favorite Directories</div>
            <div className="space-y-1">
              {visibleFavoriteDirectories.map((item) => (
                <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-xs text-text-2 active:text-accent">{formatDirectoryShortcutLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
              ))}
            </div>
          </div>
        )}
        {(listLoading || searchLoading) && <div className="p-3 text-xs text-text-3">Loading...</div>}
        {!listLoading && visibleItems.map((item: any) => (
          !isMobile && !isSearching && item.type === 'directory' ? (
            <TreeDirectoryNode
              key={item.path}
              rootId={activeRootId}
              rootBasePath={activeRootBasePath}
              item={item}
              depth={0}
              hideDotFiles={hideDotFiles}
              selectedPath={selectedPath}
              isFavoriteDirectory={isFavoriteDirectory}
              onToggle={toggleDesktopDirectory}
              onToggleFavorite={toggleFavoriteDirectory}
              onSelectFile={openItem}
              onInsert={insertItemPath}
              onContextMenu={(e, entry) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, item: entry })
              }}
              openDirectories={openDirectories}
            />
          ) : !isMobile && isSearching && item.type === 'directory' ? (
            <SearchDirectoryNode
              key={item.path}
              rootId={activeRootId}
              rootBasePath={activeRootBasePath}
              item={item}
              depth={0}
              hideDotFiles={hideDotFiles}
              searchMode={searchMode}
              query={query}
              selectedPath={selectedPath}
              isFavoriteDirectory={isFavoriteDirectory}
              onToggle={toggleDesktopDirectory}
              onToggleFavorite={toggleFavoriteDirectory}
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
                {item.type === 'directory' && <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) })} name={item.name} onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleFavoriteDirectory(item)
                }} />}
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
          <button onClick={() => { setSelectedPath(contextMenu.item.path); setSelectedPreviewLine(getPreviewLine(contextMenu.item)); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">Open preview</button>
        </div>
      )}
      </>}
    </aside>
  )
}
