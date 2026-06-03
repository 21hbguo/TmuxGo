'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaretRightOutlined, FileImageOutlined, FileMarkdownOutlined, FileOutlined, FileTextOutlined, FolderFilled } from '@ant-design/icons'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { Tree } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import { useFileList, useFilePreview, useFileRoots, useFileSearch } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FavoriteDirectory, FileContentMatch, FileDocumentHandle, FileItem, FileListResponse, FilePreviewResponse, FileRoot } from '@/types'
import { writeClipboardText } from '@/lib/clipboard-text'
import { quoteShellPath } from '@/lib/path-drop'
import { api } from '@/lib/api'
import { clearActiveDraggedFile, FILE_DRAG_MIME, setActiveDraggedFile } from '@/lib/editor-drag'
import { useTranslation } from '@/i18n'
import { usePrompt } from '@/hooks/usePrompt'
import { ConfirmDialog } from './ConfirmDialog'

type SearchMode = 'name' | 'content'
type FileTypeFilter = 'all' | 'file' | 'directory'
type FileRootOption = FileRoot & { sourceRootId: string; basePath: string }
type FileEntry = FileItem | FileContentMatch
const FAVORITE_STORAGE_KEY = 'tmuxgo-favorite-directories'
const FAVORITE_UPDATED_AT_STORAGE_KEY = 'tmuxgo-favorite-directories-updated-at'
const PREFERENCES_PROFILE = 'default'
const SEARCH_INPUT_DEBOUNCE_MS = 160
const SEARCH_RESULT_LIMIT = 200
const LARGE_DIRECTORY_LIMIT = 120
const DIRECTORY_RENDER_LIMIT = 80
const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])
const CODE_EXTENSIONS = new Set(['.c', '.cc', '.conf', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.md', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.xml', '.yaml', '.yml', '.zsh'])

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
    return Array.isArray(stored) ? stored.filter((item): item is FavoriteDirectory => !!item && typeof item.rootId === 'string' && typeof item.rootPath === 'string' && typeof item.name === 'string' && typeof item.path === 'string') : []
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
function matchesFileTypeFilter(item: { type: 'file' | 'directory' }, fileTypeFilter: FileTypeFilter) {
  if (fileTypeFilter === 'all') return true
  if (fileTypeFilter === 'file' && item.type === 'directory') return true
  return item.type === fileTypeFilter
}
function getFileVisual(path: string, type: 'file' | 'directory') {
  if (type === 'directory') return { icon: <FolderFilled className="text-[12px] text-[#dcb67a]" />, tone: 'text-text-1' }
  const lower = path.toLowerCase()
  if (isImagePath(lower)) return { icon: <FileImageOutlined className="text-[12px] text-[#61c7ff]" />, tone: 'text-[#8fdcff]' }
  if (lower.endsWith('.md')) return { icon: <FileMarkdownOutlined className="text-[12px] text-[#79d2a6]" />, tone: 'text-[#9de1bf]' }
  if (CODE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))) return { icon: <FileTextOutlined className="text-[12px] text-[#c2d1ff]" />, tone: 'text-text-1' }
  return { icon: <FileOutlined className="text-[12px] text-text-3" />, tone: 'text-text-2' }
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
function getDirectoryCacheKey(rootId: string, rootBasePath: string, itemPath: string) {
  return `${rootId}:${joinRelativePath(rootBasePath, itemPath)}`
}
function readDirectoryChildrenFromCache(cache: Map<string, FileItem[]>, rootId: string, rootBasePath: string, itemPath: string) {
  return cache.get(getDirectoryCacheKey(rootId, rootBasePath, itemPath))
}
function trimDirectoryItems(items: FileItem[]) {
  if (items.length <= LARGE_DIRECTORY_LIMIT) return { items, truncated: false }
  return { items: items.slice(0, DIRECTORY_RENDER_LIMIT), truncated: true }
}
function matchesSearchEntry(item: FileItem, query: string, mode: SearchMode, results: FileEntry[]) {
  if (!query.trim()) return true
  if (results.some((entry) => entry.path === item.path)) return true
  if (mode === 'content') return false
  return item.name.toLowerCase().includes(query.trim().toLowerCase())
}
function resolveRootRelativePath(basePath: string, itemPath: string) {
  return joinRelativePath(basePath, itemPath)
}
function getParentRelativePath(item: FileEntry, currentPath: string) {
  if (item.type === 'directory') return item.path
  const parts = item.path.split(/[\\/]+/).filter(Boolean)
  return parts.slice(0, -1).join('/') || currentPath
}
function getPreviewLine(item: FileEntry | null) {
  if (!item || !('matches' in item) || !item.matches?.length) return 1
  return Math.max(1, item.matches[0]?.number || 1)
}
function isImagePath(path: string) {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}
function FavoriteDirectoryButton({ active, name, onClick }: { active: boolean; name: string; onClick: (event: React.MouseEvent) => void }) {
  return <button onClick={onClick} className={`shrink-0 rounded px-1 py-0 text-[10px] leading-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${active ? 'bg-accent/20 text-accent opacity-100' : 'bg-bg-2 text-text-3 hover:text-text-1'}`} aria-label={`${active ? 'Unfavorite' : 'Favorite'} ${name}`}>{active ? '★' : '☆'}</button>
}
type FileTreeNode = DataNode & { item: FileItem; isLeaf?: boolean }
export function FilePanel({ mode = 'panel', dock = 'right', onClose, onOpenFile }: { mode?: 'panel' | 'mobile' | 'explorer'; dock?: 'left' | 'right'; onClose?: () => void; onOpenFile?: (file: FileDocumentHandle) => void }) {
  const queryClient = useQueryClient()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const filePanelWidth = useConsoleStore((state) => state.filePanelWidth)
  const setFilePanelWidth = useConsoleStore((state) => state.setFilePanelWidth)
  const setFilePanelOpen = useConsoleStore((state) => state.setFilePanelOpen)
  const openUploadDialog = useConsoleStore((state) => state.openUploadDialog)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const fileHostId = activeHostId || 'local'
  const { data: roots = [] } = useFileRoots(fileHostId)
  const isMobile = mode === 'mobile'
  const [selectedRootId, setSelectedRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedPreviewLine, setSelectedPreviewLine] = useState(1)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [fileTypeFilter, setFileTypeFilter] = useState<FileTypeFilter>('all')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileEntry | null; directoryPath: string } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list')
  const [favoriteDirectories, setFavoriteDirectories] = useState<FavoriteDirectory[]>([])
  const [contentReady] = useState(true)
  const [hideDotFiles, setHideDotFiles] = useState(readHideDotFiles)
  const [openDirectories, setOpenDirectories] = useState<Set<string>>(new Set())
  const [searchNavigationPath, setSearchNavigationPath] = useState<string | null>(null)
  const [directoryCache, setDirectoryCache] = useState<Map<string, FileItem[]>>(new Map())
  const resizingRef = useRef(false)
  const directoryLoadingRef = useRef<Map<string, Promise<FileItem[]>>>(new Map())
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [pendingDeleteItem, setPendingDeleteItem] = useState<FileEntry | null>(null)
  const virtualRoots = useMemo(() => favoriteDirectories.map((item) => ({ id: getFavoriteRootOptionId(item), label: item.name, path: joinPath(item.rootPath, item.path), sourceRootId: item.rootId, basePath: item.path })), [favoriteDirectories])
  const visibleRoots = useMemo(() => {
    const home = roots.find((item) => getRootKind(item) === 'home')
    return home ? [home] : roots.slice(0, 1)
  }, [roots])
  const rootOptions = useMemo(() => [...visibleRoots.map((item) => ({ ...item, sourceRootId: item.id, basePath: '' })), ...virtualRoots], [visibleRoots, virtualRoots])
  const activeRoot = rootOptions.find((item) => item.id === selectedRootId) || rootOptions[0]
  const activeRootId = activeRoot?.sourceRootId || ''
  const activeRootBasePath = activeRoot?.basePath || ''
  const activeSourceRootPath = visibleRoots.find((item) => item.id === activeRootId)?.path || roots.find((item) => item.id === activeRootId)?.path || activeRoot?.path || ''
  const activeFavorite = useMemo(() => {
    const parsed = parseFavoriteRootOptionId(selectedRootId)
    if (!parsed) return null
    return favoriteDirectories.find((item) => item.rootId === parsed.rootId && item.path === parsed.path) || null
  }, [favoriteDirectories, selectedRootId])
  const listQueryPath = joinRelativePath(activeRootBasePath, currentPath)
  const previewQueryPath = joinRelativePath(activeRootBasePath, selectedPath)
  const { data: rawListData, isLoading: listLoading } = useFileList(fileHostId, activeRootId, listQueryPath, true)
  const { data: rawPreview } = useFilePreview(fileHostId, activeRootId, previewQueryPath, selectedPreviewLine)
  const searchBasePath = joinRelativePath(activeRootBasePath, currentPath)
  const { data: rawSearchResults = [], isFetching: searchLoading } = useFileSearch(fileHostId, activeRootId, searchMode, debouncedQuery, searchBasePath)
  const root = activeRoot
  const listData = useMemo(() => rebaseListData(rawListData, activeRoot), [rawListData, activeRoot])
  const preview = useMemo(() => rebasePreview(rawPreview, activeRootBasePath), [rawPreview, activeRootBasePath])
  const searchResults = useMemo(() => rawSearchResults.slice(0, SEARCH_RESULT_LIMIT).map((item) => rebaseEntryPath(item, activeRootBasePath)), [rawSearchResults, activeRootBasePath])
  const rootLabelById = useMemo(() => Object.fromEntries(visibleRoots.map((item) => [item.id, item.label])), [visibleRoots])
  const isSearching = debouncedQuery.trim().length > 0
  const showSearchResults = isSearching && !searchNavigationPath
  const items = useMemo(() => showSearchResults ? searchResults : listData?.items || [], [showSearchResults, searchResults, listData])
  const visibleItems = useMemo(() => items.filter((item: any) => (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter)), [fileTypeFilter, hideDotFiles, items])
  const visibleFavoriteDirectories = useMemo(() => hideDotFiles ? favoriteDirectories.filter((item) => !isDotPath(item.path)) : favoriteDirectories, [hideDotFiles, favoriteDirectories])
  const storeDirectoryChildren = useCallback((rootId: string, rootBasePath: string, itemPath: string, items: FileItem[]) => {
    setDirectoryCache((current) => {
      const next = new Map(current)
      next.set(getDirectoryCacheKey(rootId, rootBasePath, itemPath), items)
      return next
    })
  }, [])
  const createTreeNodes = useCallback((items: FileItem[]): FileTreeNode[] => items.filter((item) => (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter)).map((item) => {
    const children = item.type === 'directory' && openDirectories.has(item.path) ? readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path) : undefined
    const nextChildren = children ? createTreeNodes(children) : undefined
    return { key: item.path, title: item.name, isLeaf: item.type === 'file', children: nextChildren, item }
  }), [activeRootBasePath, activeRootId, directoryCache, fileTypeFilter, hideDotFiles, openDirectories])
  const desktopTreeData = useMemo(() => !isMobile && !showSearchResults ? createTreeNodes(listData?.items || []) : [], [createTreeNodes, isMobile, listData?.items, showSearchResults])

  useEffect(() => {
    if (!selectedRootId && rootOptions[0]) setSelectedRootId(rootOptions[0].id)
  }, [rootOptions, selectedRootId])
  useEffect(() => {
    setSelectedRootId('')
    setCurrentPath('')
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setQuery('')
    setDebouncedQuery('')
    setMobileView('list')
    setOpenDirectories(new Set())
    setSearchNavigationPath(null)
    setDirectoryCache(new Map())
    directoryLoadingRef.current.clear()
  }, [fileHostId])
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_INPUT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
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
  const pushMobileNavigationHistory = () => {
    if (!isMobile || typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-push-level'))
  }
  const goMobileParentDirectory = () => {
    setCurrentPath((value) => {
      const parts = value.split(/[\\/]+/).filter(Boolean)
      return parts.slice(0, -1).join('/')
    })
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setSearchNavigationPath((value) => {
      if (!value) return null
      const parts = value.split(/[\\/]+/).filter(Boolean)
      return parts.length > 1 ? parts.slice(0, -1).join('/') : null
    })
  }
  useEffect(() => {
    if (!isMobile) return
    const handleBack = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail
      if (mobileView === 'preview') {
        detail.handled = true
        setMobileView('list')
        return
      }
      if (!currentPath) return
      detail.handled = true
      goMobileParentDirectory()
    }
    window.addEventListener('tmuxgo-mobile-files-back', handleBack as EventListener)
    return () => window.removeEventListener('tmuxgo-mobile-files-back', handleBack as EventListener)
  }, [currentPath, isMobile, mobileView])
  const switchRoot = (nextRootId: string) => {
    setSelectedRootId(nextRootId)
    setCurrentPath('')
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setMobileView('list')
    setOpenDirectories(new Set())
    setSearchNavigationPath(null)
    setDirectoryCache(new Map())
    directoryLoadingRef.current.clear()
  }
  const openDirectoryShortcut = (entry: { rootId: string; path: string }) => {
    const nextRootId = getFavoriteRootOptionId(entry)
    setSelectedRootId(nextRootId)
    if (isMobile) setCurrentPath('')
    else setOpenDirectories(new Set())
    setSelectedPath('')
    setSelectedPreviewLine(1)
    setMobileView('list')
    setSearchNavigationPath(null)
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
  const setDesktopDirectoryExpanded = (path: string, expanded: boolean) => {
    setOpenDirectories((current) => {
      const next = new Set(current)
      if (expanded) next.add(path)
      else next.delete(path)
      return next
    })
  }
  const handleDesktopDirectoryToggle = (item: FileItem) => {
    let expanding = false
    setOpenDirectories((current) => {
      const next = new Set(current)
      if (next.has(item.path)) next.delete(item.path)
      else { next.add(item.path); expanding = true }
      return next
    })
    if (expanding) void loadDirectoryChildren(item)
    setSelectedPath(item.path)
  }
  const loadDirectoryChildren = async (item: FileItem) => {
    const cacheKey = getDirectoryCacheKey(activeRootId, activeRootBasePath, item.path)
    const cache = directoryCache.get(cacheKey)
    if (cache) return cache
    const pending = directoryLoadingRef.current.get(cacheKey)
    if (pending) return pending
    const request = api.files.list(fileHostId, activeRootId, joinRelativePath(activeRootBasePath, item.path)).then((result) => {
      const nextItems = result.items.map((entry) => rebaseEntryPath(entry, activeRootBasePath))
      storeDirectoryChildren(activeRootId, activeRootBasePath, item.path, nextItems)
      return nextItems
    }).catch(() => []).finally(() => {
      directoryLoadingRef.current.delete(cacheKey)
    })
    directoryLoadingRef.current.set(cacheKey, request)
    try {
      return await request
    } catch {
      return []
    }
  }

  const openInEditor = (item: FileEntry) => {
    if (!onOpenFile || item.type !== 'file' || !root) return false
    onOpenFile(createFileHandle(item))
    return true
  }
  const createFileHandle = (item: FileEntry): FileDocumentHandle => {
    const filePath = resolveRootRelativePath(activeRootBasePath, item.path)
    return {
      id: `${fileHostId}:${activeRootId}:${filePath}`,
      hostId: fileHostId,
      rootId: activeRootId,
      rootLabel: root.label,
      rootPath: root.path,
      path: filePath,
      name: item.name,
      absolutePath: joinPath(activeSourceRootPath, filePath),
    }
  }
  const bindFileDrag = (item: FileEntry) => item.type !== 'file' || isMobile ? {} : {
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      const handle = createFileHandle(item)
      setActiveDraggedFile(handle)
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(handle))
    },
    onDragEnd: () => clearActiveDraggedFile(),
  }
  const openItem = (item: FileEntry) => {
    if (item.type === 'directory') {
      if (!isMobile && showSearchResults) {
        void handleDesktopDirectoryToggle(item)
        return
      }
      if (!isMobile) {
        void handleDesktopDirectoryToggle(item)
        return
      }
      pushMobileNavigationHistory()
      setCurrentPath(item.path)
      setSelectedPath('')
      setSelectedPreviewLine(1)
      setMobileView('list')
      setSearchNavigationPath(isSearching ? item.path : null)
      return
    }
    if (!isMobile && openInEditor(item)) return
    if (isMobile) pushMobileNavigationHistory()
    setSelectedPath(item.path)
    setSelectedPreviewLine(getPreviewLine(item))
    if (isMobile) setMobileView('preview')
  }
  const insertItemPath = (item: FileItem | FileContentMatch) => {
    const rootRelativePath = resolveRootRelativePath(activeRootBasePath, item.path)
    const full = activeSourceRootPath ? joinPath(activeSourceRootPath, rootRelativePath) : rootRelativePath
    insertPath(full)
    pushToast({ type: 'success', message: t('file.inserted', { name: item.name }) })
  }
  const copyItemPath = async (item: FileItem | FileContentMatch) => {
    const rootRelativePath = resolveRootRelativePath(activeRootBasePath, item.path)
    const full = activeSourceRootPath ? joinPath(activeSourceRootPath, rootRelativePath) : rootRelativePath
    const result = await writeClipboardText(full)
    if (!result.copied) {
      pushToast({ type: 'error', message: t('file.copyFailed') })
      return
    }
    pushToast({ type: 'success', message: result.unavailable ? t('file.pathCopied') : t('file.pathCopied') })
  }
  const copyItemName = async (item: FileItem | FileContentMatch) => {
    const result = await writeClipboardText(item.name)
    if (!result.copied) {
      pushToast({ type: 'error', message: t('file.copyFailed') })
      return
    }
    pushToast({ type: 'success', message: result.unavailable ? t('file.nameCopiedInApp') : t('file.nameCopied') })
  }
  const copyItemRelativePath = async (item: FileItem | FileContentMatch) => {
    const result = await writeClipboardText(resolveRootRelativePath(activeRootBasePath, item.path))
    if (!result.copied) {
      pushToast({ type: 'error', message: t('file.copyFailed') })
      return
    }
    pushToast({ type: 'success', message: result.unavailable ? t('file.relativePathCopiedInApp') : t('file.relativePathCopied') })
  }
  const refreshFiles = useCallback(() => {
    setDirectoryCache(new Map())
    directoryLoadingRef.current.clear()
    void queryClient.invalidateQueries({ queryKey: ['file-list', fileHostId, activeRootId] })
    void queryClient.invalidateQueries({ queryKey: ['file-search', fileHostId, activeRootId] })
    void queryClient.invalidateQueries({ queryKey: ['file-preview', fileHostId, activeRootId] })
  }, [activeRootId, fileHostId, queryClient])
  const clearExpandedDirectories = () => {
    setOpenDirectories(new Set())
    setDirectoryCache(new Map())
    directoryLoadingRef.current.clear()
  }
  const getItemFullPath = (item: FileEntry) => {
    const rootRelativePath = resolveRootRelativePath(activeRootBasePath, item.path)
    return activeSourceRootPath ? joinPath(activeSourceRootPath, rootRelativePath) : rootRelativePath
  }
  const startDownload = (item: FileItem | FileContentMatch) => {
    if (item.type !== 'file') {
      pushToast({ type: 'error', message: t('file.onlyFilesDownload') })
      return
    }
    const anchor = document.createElement('a')
    anchor.href = api.files.downloadUrl(fileHostId, activeRootId, resolveRootRelativePath(activeRootBasePath, item.path), preferences.downloadRateLimitKBps)
    anchor.download = item.name
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    pushToast({ type: 'success', message: t('file.downloading', { name: item.name }) })
  }
  const createEntry = async (kind: 'file' | 'directory', directoryPath: string) => {
    const name = await prompt(kind === 'file' ? t('file.newFileName') : t('file.newFolderName'), '')
    if (!name?.trim()) return
    try {
      if (kind === 'file') await api.files.createFile(fileHostId, activeRootId, joinRelativePath(activeRootBasePath, directoryPath), name.trim())
      else await api.files.createDirectory(fileHostId, activeRootId, joinRelativePath(activeRootBasePath, directoryPath), name.trim())
      refreshFiles()
      pushToast({ type: 'success', message: kind === 'file' ? t('file.fileCreated') : t('file.folderCreated') })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.createFailed') })
    }
  }
  const renameItem = async (item: FileItem | FileContentMatch) => {
    const name = await prompt(t('file.renamePrompt', { name: item.name }), item.name)
    if (!name?.trim() || name.trim() === item.name) return
    try {
      const result = await api.files.rename(fileHostId, activeRootId, resolveRootRelativePath(activeRootBasePath, item.path), name.trim())
      if (selectedPath === item.path) setSelectedPath(stripBasePath(result.item.path, activeRootBasePath))
      refreshFiles()
      pushToast({ type: 'success', message: t('file.renamed', { name: item.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.renameFailed') })
    }
  }
  const removeItem = async (item: FileItem | FileContentMatch) => {
    setPendingDeleteItem(item)
  }
  const confirmRemoveItem = async () => {
    const item = pendingDeleteItem
    if (!item) return
    setPendingDeleteItem(null)
    try {
      await api.files.remove(fileHostId, activeRootId, resolveRootRelativePath(activeRootBasePath, item.path))
      if (selectedPath === item.path) {
        setSelectedPath('')
        setSelectedPreviewLine(1)
      }
      refreshFiles()
      pushToast({ type: 'success', message: t('file.deleted', { name: item.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.deleteFailed') })
    }
  }
  const showContextMenu = (x: number, y: number, item: FileEntry | null, directoryPath: string) => {
    setContextMenu({ x, y, item, directoryPath })
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
  const embedded = mode === 'explorer'
  const shellClass = isMobile ? 'flex h-full min-h-0 flex-col bg-bg-1' : `relative flex h-full ${embedded ? 'min-w-0 flex-1' : 'shrink-0'} flex-col bg-bg-1 ${dock === 'left' ? 'border-r border-[var(--line)]' : 'border-l border-[var(--line)]'}`
  const shellStyle = isMobile || embedded ? undefined : { width: filePanelWidth }
  const imagePreviewUrl = preview?.path && preview.type === 'file' && isImagePath(preview.path) && (preview.binary || preview.reason === 'binary-file' || preview.reason === 'large-file') ? api.files.imageUrl(fileHostId, activeRootId, resolveRootRelativePath(activeRootBasePath, preview.path), preview.modifiedAt) : ''
  const previewBlock = preview ? (
    imagePreviewUrl ? (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 p-3 text-xs text-text-3">
          <div className="font-mono text-text-1">{preview.path}</div>
          <div className="mt-1">{formatSize(preview.size)}</div>
        </div>
        <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-auto px-3 pb-3">
          <img src={imagePreviewUrl} alt={preview.path} className="mx-auto block max-h-full max-w-full rounded border border-[var(--line)] bg-bg-1 object-contain" />
        </div>
      </div>
    ) : preview.binary || preview.reason ? (
      <div className="p-3 text-xs text-text-3">
        <div className="font-mono text-text-1">{preview.path}</div>
        <div className="mt-2">{preview.reason === 'large-file' ? t('file.previewSkippedLarge') : preview.reason === 'binary-file' ? t('file.previewSkippedBinary') : t('file.previewUnavailable')}</div>
        <div className="mt-1">{formatSize(preview.size)}</div>
      </div>
    ) : (
      <div className="tmuxgo-scrollbar h-full overflow-auto p-2 font-mono text-[11px] leading-5">
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
      <div className="text-text-2">{t('file.favorites')}</div>
      {visibleFavoriteDirectories.length ? (
        <div className="mt-2 space-y-1">
          {visibleFavoriteDirectories.map((item) => (
            <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="block w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-[11px] text-text-2 hover:text-accent">{formatDirectoryShortcutLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
          ))}
        </div>
      ) : (
        <div className="mt-2">{t('file.favoritesHint')}</div>
      )}
    </div>
  )
  const renderTreeTitle = (node: FileTreeNode) => {
    const item = node.item
    const visual = getFileVisual(item.path, item.type)
    const favoritePath = { rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) }
    return (
      <div
        role="button"
        tabIndex={0}
        title={getItemFullPath(item)}
        {...bindFileDrag(item)}
        onClick={(e) => {
          e.preventDefault()
          if (item.type === 'directory') void handleDesktopDirectoryToggle(item)
          else {
            setSelectedPath(item.path)
            openItem(item)
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          if (item.type === 'directory') void handleDesktopDirectoryToggle(item)
          else {
            setSelectedPath(item.path)
            openItem(item)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
        }}
        onDoubleClick={() => item.type === 'directory' ? void handleDesktopDirectoryToggle(item) : insertItemPath(item)}
        className="group flex min-w-0 items-center gap-1.5 px-2 py-[2px]"
      >
        <span className="shrink-0">{visual.icon}</span>
        <span className={`min-w-0 flex-1 truncate font-mono ${visual.tone}`}>{item.name}</span>
        {item.type === 'directory' ? <FavoriteDirectoryButton active={isFavoriteDirectory(favoritePath)} name={item.name} onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          toggleFavoriteDirectory(item)
        }} /> : <span className="invisible text-[10px] text-text-3 group-hover:visible">{formatSize(item.size)}</span>}
      </div>
    )
  }
  const renderSearchList = (entries: FileEntry[], depth = 0): React.ReactNode[] => entries.filter((item) => (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter)).flatMap((item) => {
    const cache = item.type === 'directory' ? readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path) : undefined
    const nested = item.type === 'directory' && openDirectories.has(item.path) && cache ? renderSearchList(cache, depth + 1) : []
    const visual = getFileVisual(item.path, item.type)
    return [
      <button
        key={`${item.type}-${item.path}`}
        tabIndex={0}
        title={getItemFullPath(item)}
        {...bindFileDrag(item)}
        onClick={() => openItem(item)}
        onDoubleClick={() => item.type === 'directory' ? void handleDesktopDirectoryToggle(item) : insertItemPath(item)}
        onKeyDown={(e) => {
          if (item.type === 'directory' && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            void handleDesktopDirectoryToggle(item)
            return
          }
          selectFromKeyboard(item, e)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
        }}
        onTouchStart={(e) => {
          if (!isMobile) return
          const touch = e.touches[0]
          if (!touch) return
          if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
          touchTimerRef.current = setTimeout(() => showContextMenu(touch.clientX, touch.clientY, item, getParentRelativePath(item, currentPath)), 520)
        }}
        onTouchMove={() => {
          if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
          touchTimerRef.current = null
        }}
        onTouchEnd={() => {
          if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
          touchTimerRef.current = null
        }}
        className={`group w-full border-l-2 px-2 py-[3px] text-left text-[11px] leading-4 transition-colors hover:bg-bg-2 ${selectedPath === item.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
        style={!isMobile && showSearchResults ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex shrink-0 items-center gap-1">
            {item.type === 'directory' && <span className="w-2 text-[#dcb67a]">{openDirectories.has(item.path) ? '▾' : '▸'}</span>}
            <span>{visual.icon}</span>
          </span>
          <span className={`min-w-0 flex-1 truncate font-mono ${item.type === 'directory' ? 'text-text-1' : visual.tone}`}>{item.name}</span>
          {item.type === 'directory' && <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) })} name={item.name} onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            toggleFavoriteDirectory(item)
          }} />}
          <span className="invisible text-[10px] text-text-3 group-hover:visible">{item.type === 'file' ? formatSize(item.size) : 'dir'}</span>
        </div>
        {'matches' in item && item.matches?.[0] && <div className="truncate pl-4 font-mono text-[10px] text-text-3">L{item.matches[0].number}: {item.matches[0].content}</div>}
      </button>,
      ...nested,
    ]
  })

  return (
    <aside className={shellClass} style={shellStyle}>
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadSelect} />
      {!isMobile && !embedded && (
        <div
          className={`absolute top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 ${dock === 'left' ? 'right-0' : 'left-0'}`}
          onMouseDown={() => {
            resizingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />
      )}
      {!contentReady ? <div className="flex h-full items-center justify-center text-xs text-text-3">{t('file.loading')}</div> : <>
      <div className="border-b border-[var(--line)] px-2 py-2">
        <div className="flex items-center gap-1.5">
          {isMobile && mobileView === 'preview' && <button onClick={() => setMobileView('list')} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2">‹</button>}
          {isMobile && mobileView !== 'preview' && !!currentPath && <button onClick={goMobileParentDirectory} className="rounded px-2 py-1 text-text-3 hover:bg-bg-2">‹</button>}
          <div className="text-sm font-semibold text-text-1">{t('file.title')}</div>
          <select value={selectedRootId} onChange={(e) => switchRoot(e.target.value)} className="tmuxgo-control tmuxgo-select min-w-0 flex-1 rounded px-2 py-1 text-[11px]">
            {rootOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <button onClick={() => uploadInputRef.current?.click()} className="rounded px-1.5 py-1 text-[11px] text-accent hover:bg-bg-2">{t('file.upload')}</button>
          {activeFavorite && <button onClick={() => removeFavoriteDirectory(activeFavorite)} className="rounded px-1.5 py-1 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('file.removeFavorite')}</button>}
          <button onClick={onClose || (() => setFilePanelOpen(false))} className="rounded px-1.5 py-1 text-text-3 hover:bg-bg-2 hover:text-text-1">×</button>
        </div>
        <div className="tmuxgo-scrollbar-subtle mt-1.5 flex min-w-0 items-center gap-1 overflow-x-auto text-[11px] text-text-3">
          {(listData?.breadcrumbs || [{ name: '/', path: '' }]).map((crumb) => (
            <button key={crumb.path || '/'} onClick={() => { setCurrentPath(crumb.path); setSelectedPath(''); setSelectedPreviewLine(1); setSearchNavigationPath(query.trim().length > 0 && crumb.path ? crumb.path : null); if (!crumb.path) setOpenDirectories(new Set()) }} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-2 hover:text-accent">{crumb.name}</button>
          ))}
        </div>
      </div>
      {(!isMobile || mobileView === 'list') && <div className="border-b border-[var(--line)] px-2 py-2">
        <div className="flex rounded border border-[var(--line)] bg-bg-2 p-0.5 text-[11px]">
          {(['name', 'content'] as SearchMode[]).map((item) => (
            <button key={item} onClick={() => { setSearchMode(item); setSearchNavigationPath(null) }} className={`flex-1 rounded px-2 py-0.5 capitalize ${searchMode === item ? 'bg-accent/20 text-accent' : 'text-text-3 hover:text-text-1'}`}>{item}</button>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setSearchNavigationPath(null) }} placeholder={searchMode === 'name' ? t('file.searchName') : t('file.searchContent')} className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded px-2 py-1 font-mono text-[11px]" />
          <button onClick={clearExpandedDirectories} disabled={!openDirectories.size && !directoryCache.size} aria-label={t('file.clearExpanded')} className={`shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[11px] ${openDirectories.size || directoryCache.size ? 'bg-bg-2 text-text-2 hover:text-accent' : 'bg-bg-0 text-text-3/40'}`}>⌂</button>
          <button onClick={() => { setQuery(''); setDebouncedQuery(''); setSearchNavigationPath(null) }} disabled={!query} aria-label={t('file.clearSearch')} className={`shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[11px] ${query ? 'bg-bg-2 text-text-2 hover:text-accent' : 'bg-bg-0 text-text-3/40'}`}>×</button>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <div className="flex min-w-0 flex-1 rounded border border-[var(--line)] bg-bg-0 p-0.5 text-[11px]">
            {(['all', 'file', 'directory'] as FileTypeFilter[]).map((item) => (
              <button key={item} onClick={() => setFileTypeFilter(item)} className={`min-w-0 flex-1 rounded px-2 py-0.5 ${fileTypeFilter === item ? 'bg-accent/20 text-accent' : 'text-text-3 hover:text-text-1'}`}>{item === 'all' ? t('file.all') : item === 'file' ? t('file.file') : t('file.dir')}</button>
            ))}
          </div>
          <button onClick={() => updateHideDotFiles(!hideDotFiles)} className={`shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[11px] ${hideDotFiles ? 'bg-bg-0 text-text-3 hover:text-text-1' : 'bg-accent/20 text-accent'}`}>{t('file.dotfiles')}</button>
        </div>
      </div>}
      {(!isMobile || mobileView === 'list') && <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto" onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, null, currentPath)
      }}>
        {isMobile && !showSearchResults && !currentPath && visibleFavoriteDirectories.length > 0 && (
          <div className="border-b border-[var(--line)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-text-3">{t('file.favoriteDirs')}</div>
            <div className="space-y-1">
              {visibleFavoriteDirectories.map((item) => (
                <button key={`${item.rootId}-${item.path}`} onClick={() => openDirectoryShortcut(item)} className="w-full truncate rounded bg-bg-2 px-2 py-1.5 text-left font-mono text-xs text-text-2 active:text-accent">{formatDirectoryShortcutLabel(item.path, rootLabelById[item.rootId] || item.name)}</button>
              ))}
            </div>
          </div>
        )}
        {(listLoading || searchLoading) && <div className="p-3 text-xs text-text-3">{t('file.loading')}</div>}
        {!isMobile && !showSearchResults && !listLoading && (
          <Tree
            className="tmuxgo-file-tree"
            showIcon={false}
            blockNode
            motion={null}
            virtual={false}
            switcherIcon={<CaretRightOutlined className="text-[10px]" />}
            treeData={desktopTreeData}
            expandedKeys={Array.from(openDirectories)}
            selectedKeys={selectedPath ? [selectedPath] : []}
            onExpand={(keys, info) => {
              const item = (info.node as EventDataNode<FileTreeNode>).item
              if (!item || item.type !== 'directory') return
              setDesktopDirectoryExpanded(item.path, info.expanded)
              if (info.expanded) void loadDirectoryChildren(item)
            }}
            onSelect={(keys, info) => {
              const node = info.node as EventDataNode<FileTreeNode>
              if (!node.item) return
              if (keys[0]) setSelectedPath(String(keys[0]))
            }}
            titleRender={(node) => renderTreeTitle(node as FileTreeNode)}
          />
        )}
        {!listLoading && showSearchResults && !isMobile && renderSearchList(visibleItems)}
        {!listLoading && isMobile && visibleItems.map((item: any) => (
          item.type === 'directory' ? (
            <button
              key={`${item.type}-${item.path}`}
              tabIndex={0}
              title={getItemFullPath(item)}
              onClick={() => openItem(item)}
              onDoubleClick={() => insertItemPath(item)}
              onKeyDown={(e) => selectFromKeyboard(item, e)}
              onContextMenu={(e) => {
                e.preventDefault()
                showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
              }}
              className={`group w-full border-l-2 px-2 py-1 text-left text-[11px] leading-5 transition-colors hover:bg-bg-2 ${selectedPath === item.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[#dcb67a]">▸</span>
                <span className="min-w-0 flex-1 truncate font-mono text-text-1">{item.name}</span>
                <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) })} name={item.name} onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleFavoriteDirectory(item)
                }} />
              </div>
            </button>
          ) : (
            <button
              key={`${item.type}-${item.path}`}
              tabIndex={0}
              title={getItemFullPath(item)}
              onClick={() => openItem(item)}
              onDoubleClick={() => insertItemPath(item)}
              onKeyDown={(e) => selectFromKeyboard(item, e)}
              onContextMenu={(e) => {
                e.preventDefault()
                showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
              }}
              onTouchStart={(e) => {
                if (!isMobile) return
                const touch = e.touches[0]
                if (!touch) return
                if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
                touchTimerRef.current = setTimeout(() => showContextMenu(touch.clientX, touch.clientY, item, getParentRelativePath(item, currentPath)), 520)
              }}
              onTouchMove={() => {
                if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
                touchTimerRef.current = null
              }}
              onTouchEnd={() => {
                if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
                touchTimerRef.current = null
              }}
            className={`group w-full border-l-2 px-2 py-[3px] text-left text-[11px] leading-4 transition-colors hover:bg-bg-2 ${selectedPath === item.path ? 'border-accent bg-bg-2' : 'border-transparent'}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="shrink-0">{getFileVisual(item.path, item.type).icon}</span>
                <span className={`min-w-0 flex-1 truncate font-mono ${getFileVisual(item.path, item.type).tone}`}>{item.name}</span>
                {item.type === 'directory' && <FavoriteDirectoryButton active={isFavoriteDirectory({ rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) })} name={item.name} onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleFavoriteDirectory(item)
                }} />}
                <span className="invisible text-[10px] text-text-3 group-hover:visible">{item.type === 'file' ? formatSize(item.size) : 'dir'}</span>
              </div>
              {'matches' in item && item.matches?.[0] && <div className="truncate pl-4 font-mono text-[10px] text-text-3">L{item.matches[0].number}: {item.matches[0].content}</div>}
            </button>
          )
        ))}
        {!listLoading && !visibleItems.length && <div className="p-3 text-xs text-text-3">{showSearchResults ? t('file.noResults') : t('file.emptyDir')}</div>}
        {showSearchResults && rawSearchResults.length > SEARCH_RESULT_LIMIT && <div className="border-t border-[var(--line)] px-3 py-2 text-[11px] text-text-3">{t('file.tooManyResults', { count: SEARCH_RESULT_LIMIT })}</div>}
      </div>}
      {isMobile && mobileView === 'preview' && <div className="min-h-0 flex-1 bg-bg-0">{previewBlock}</div>}
      {isMobile && mobileView === 'preview' && selectedPath && <div className="border-t border-[var(--line)] p-3"><button onClick={() => insertPath(activeSourceRootPath ? joinPath(activeSourceRootPath, resolveRootRelativePath(activeRootBasePath, selectedPath)) : resolveRootRelativePath(activeRootBasePath, selectedPath))} className="w-full rounded-lg bg-accent/20 px-3 py-3 text-sm text-accent active:scale-[0.98]">{t('file.insertPath')}</button></div>}
      {contextMenu && (
        <div className="fixed z-[90] w-44 overflow-hidden rounded border border-[var(--line)] bg-bg-1 py-1 text-xs shadow-lg" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          {contextMenu.item?.type === 'file' && <button onClick={() => { openInEditor(contextMenu.item!); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.openEditor')}</button>}
          {contextMenu.item && <button onClick={() => { insertItemPath(contextMenu.item!); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.insertPathCtx')}</button>}
          {contextMenu.item && <button onClick={() => void copyItemName(contextMenu.item!).finally(() => setContextMenu(null))} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.copyName')}</button>}
          {contextMenu.item && <button onClick={() => void copyItemRelativePath(contextMenu.item!).finally(() => setContextMenu(null))} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.copyRelativePath')}</button>}
          {contextMenu.item && <button onClick={() => void copyItemPath(contextMenu.item!).finally(() => setContextMenu(null))} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.copyPath')}</button>}
          {contextMenu.item?.type === 'file' && <button onClick={() => { setSelectedPath(contextMenu.item!.path); setSelectedPreviewLine(getPreviewLine(contextMenu.item!)); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.openPreview')}</button>}
          {contextMenu.item?.type === 'file' && <button onClick={() => { startDownload(contextMenu.item!); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.download')}</button>}
          {contextMenu.item && <button onClick={() => { void renameItem(contextMenu.item!); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.rename')}</button>}
          <button onClick={() => { void createEntry('file', contextMenu.directoryPath); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.newFile')}</button>
          <button onClick={() => { void createEntry('directory', contextMenu.directoryPath); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-text-2 hover:bg-bg-2 hover:text-accent">{t('file.newFolder')}</button>
          {contextMenu.item && <button onClick={() => { void removeItem(contextMenu.item!); setContextMenu(null) }} className="block w-full px-3 py-2 text-left text-danger hover:bg-bg-2">{t('file.delete')}</button>}
        </div>
      )}
      </>}
      {PromptElement}
      <ConfirmDialog
        open={!!pendingDeleteItem}
        title={t('file.delete')}
        message={t('file.deleteConfirm', { type: pendingDeleteItem?.type === 'directory' ? t('file.newFolder').toLowerCase() : t('file.file').toLowerCase(), path: pendingDeleteItem ? resolveRootRelativePath(activeRootBasePath, pendingDeleteItem.path) : '' })}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteItem(null)}
        onConfirm={() => void confirmRemoveItem()}
      />
    </aside>
  )
}
