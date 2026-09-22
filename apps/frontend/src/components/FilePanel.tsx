'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useFileList, useFilePreview, useFileRoots, useFileSearch, usePaneCwd } from '@/hooks/useApi'
import { usePreferences } from '@/hooks/usePreferences'
import { useSessionWorkspaces } from '@/hooks/useSessionWorkspaces'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type {
  FavoriteDirectory,
  FileContentMatch,
  FileDocumentHandle,
  FileItem,
  FileListResponse,
  FilePreviewResponse,
  FileRoot,
  TrashEntry,
} from '@/types'
import { writeClipboardText } from '@/lib/clipboard-text'
import { quoteShellPath } from '@/lib/path-drop'
import { api, fetchApiBlob } from '@/lib/api'
import { clearActiveDraggedFile, FILE_DRAG_MIME, readDraggedFile, setActiveDraggedFile } from '@/lib/editor-drag'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { MARKDOWN_PROSE_CLASS, renderMarkdown } from '@/lib/markdown'
import { CsvTable } from './CsvTable'
import { getFileIcon } from '@/lib/file-icons'
import { ZoomSurface } from './ZoomSurface'
import {
  FiAlignLeft,
  FiArrowUp,
  FiChevronsUp,
  FiEye,
  FiEyeOff,
  FiFile,
  FiFileText,
  FiFolder,
  FiLayers,
  FiRefreshCw,
  FiSearch,
  FiStar,
  FiTrash2,
  FiUpload,
} from 'react-icons/fi'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { Chip } from './Chip'
import { usePrompt } from '@/hooks/usePrompt'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'
import { chooseFileRoot, getRootRelativePath } from '@/lib/terminal-paths'

type SearchMode = 'name' | 'content'
type FileTypeFilter = 'all' | 'file' | 'directory'
type SortField = 'name' | 'size' | 'modified'
type SortDirection = 'asc' | 'desc'
type FileSort = { field: SortField; direction: SortDirection }
type FileRootOption = FileRoot & { sourceRootId: string; basePath: string }
type FileEntry = FileItem | FileContentMatch
type DirectoryStatus = { state: 'loading' | 'error'; message: string }
const FAVORITE_STORAGE_KEY = 'tmuxgo-favorite-directories'
const FAVORITE_UPDATED_AT_STORAGE_KEY = 'tmuxgo-favorite-directories-updated-at'
const PREFERENCES_PROFILE = 'default'
const SEARCH_INPUT_DEBOUNCE_MS = 160
const SEARCH_RESULT_LIMIT = 200
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
])

function formatSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${Math.round(size / 1024 / 1024)}MB`
}
function formatModeBits(mode: number | undefined, type: 'file' | 'directory') {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) return '-'
  const flags = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x']
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  let symbolic = type === 'directory' ? 'd' : '-'
  for (let i = 0; i < 9; i++) symbolic += mode & bits[i] ? flags[i] : '-'
  return `${symbolic} (${mode.toString(8)})`
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
  return `${base}/${name}`
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}
function readFavoriteDirectories() {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITE_STORAGE_KEY) || '[]')
    return Array.isArray(stored)
      ? stored.filter(
          (item): item is FavoriteDirectory =>
            !!item &&
            typeof item.rootId === 'string' &&
            typeof item.rootPath === 'string' &&
            typeof item.name === 'string' &&
            typeof item.path === 'string',
        )
      : []
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
  const next = exists
    ? current.filter((item) => item.rootId !== entry.rootId || item.path !== entry.path)
    : [entry, ...current].slice(0, 12)
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
    if (
      a[i].rootId !== b[i].rootId ||
      a[i].rootPath !== b[i].rootPath ||
      a[i].name !== b[i].name ||
      a[i].path !== b[i].path
    )
      return false
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
    const normalizedPath = (entry.path || '')
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
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
const FOLLOW_ACTIVE_PATH_STORAGE_KEY = 'tmuxgo-file-follow-active-path'
function readFollowActivePath() {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(FOLLOW_ACTIVE_PATH_STORAGE_KEY) === 'true'
}
function writeFollowActivePath(value: boolean) {
  localStorage.setItem(FOLLOW_ACTIVE_PATH_STORAGE_KEY, String(value))
}
const FILE_SORT_STORAGE_KEY = 'tmuxgo-file-sort'
function readFileSort(): FileSort {
  if (typeof window === 'undefined') return { field: 'name', direction: 'asc' }
  try {
    const stored = localStorage.getItem(FILE_SORT_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed.field && parsed.direction) return parsed as FileSort
    }
  } catch {}
  return { field: 'name', direction: 'asc' }
}
function writeFileSort(sort: FileSort) {
  localStorage.setItem(FILE_SORT_STORAGE_KEY, JSON.stringify(sort))
}
function compareFileItems(a: FileItem, b: FileItem, sort: FileSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1
  const typeWeight = (item: FileItem) => (item.type === 'directory' ? 0 : 1)
  const typeDelta = typeWeight(a) - typeWeight(b)
  if (typeDelta !== 0) return typeDelta * sign
  if (sort.field === 'name') return a.name.localeCompare(b.name) * sign
  if (sort.field === 'size') return (a.size - b.size) * sign
  if (sort.field === 'modified') return a.modifiedAt.localeCompare(b.modifiedAt) * sign
  return a.name.localeCompare(b.name) * sign
}
function isDotPath(path: string) {
  return path.split(/[\\/]+/).some((part) => part.startsWith('.') && part.length > 1)
}
function matchesFileTypeFilter(item: { type: 'file' | 'directory' }, fileTypeFilter: FileTypeFilter) {
  if (fileTypeFilter === 'all') return true
  return item.type === fileTypeFilter
}
// 图标层委托给 file-icons（VSCode 风格：品牌色 si 图标 + vsc 兜底）；
// tone 语义保留，open 透传目录展开态
function getFileVisual(path: string, type: 'file' | 'directory', open = false) {
  return { icon: getFileIcon(path, type, { open }), tone: 'text-text-1' }
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
function formatDirectoryShortcutLabel(path: string, rootLabel: string, rootPath: string) {
  return joinPath(rootPath, path) || '/'
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
  const normalizedPath = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  const normalizedBasePath = basePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  if (!normalizedBasePath) return normalizedPath
  if (!normalizedPath || normalizedPath === normalizedBasePath) return ''
  const prefix = `${normalizedBasePath}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath
}
function pathIncludesBasePath(path: string, basePath: string) {
  const normalizedPath = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  const normalizedBasePath = basePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  if (!normalizedBasePath) return true
  return normalizedPath === normalizedBasePath || normalizedPath.startsWith(`${normalizedBasePath}/`)
}
function getParentPath(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.slice(0, -1).join('/')
}
function getMatchingRootOption(rootOptions: FileRootOption[], rootId: string, path: string) {
  const candidates = rootOptions.filter(
    (item) => item.sourceRootId === rootId && pathIncludesBasePath(path, item.basePath),
  )
  if (!candidates.length) return null
  return candidates.reduce((best, item) => (item.basePath.length > best.basePath.length ? item : best))
}
function rebaseEntryPath<T extends { path: string }>(entry: T, basePath: string) {
  const nextPath = stripBasePath(entry.path, basePath)
  return nextPath === entry.path ? entry : { ...entry, path: nextPath }
}
function rebaseListData(listData: FileListResponse | undefined, root: FileRootOption | undefined) {
  if (!listData || !root) return listData
  const nextPath = stripBasePath(listData.path, root.basePath)
  return {
    ...listData,
    root: { id: root.id, label: root.label, path: root.path },
    path: nextPath,
    breadcrumbs: getBreadcrumbs(nextPath),
    items: listData.items.map((item) => rebaseEntryPath(item, root.basePath)),
  }
}
function rebasePreview(preview: FilePreviewResponse | undefined, basePath: string) {
  if (!preview) return preview
  return rebaseEntryPath(preview, basePath)
}
function getDirectoryCacheKey(rootId: string, rootBasePath: string, itemPath: string) {
  return `${rootId}:${joinRelativePath(rootBasePath, itemPath)}`
}
function readDirectoryChildrenFromCache(
  cache: Map<string, FileItem[]>,
  rootId: string,
  rootBasePath: string,
  itemPath: string,
) {
  return cache.get(getDirectoryCacheKey(rootId, rootBasePath, itemPath))
}
function readDirectoryStatusFromCache(
  cache: Map<string, DirectoryStatus>,
  rootId: string,
  rootBasePath: string,
  itemPath: string,
) {
  return cache.get(getDirectoryCacheKey(rootId, rootBasePath, itemPath))
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
function VirtualizedRows({
  rows,
  rowHeight,
  className,
  resetKey,
  ensureVisibleIndex = -1,
}: {
  rows: React.ReactNode[]
  rowHeight: number
  className: string
  resetKey: string
  ensureVisibleIndex?: number
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateHeight = () => setViewportHeight(viewport.clientHeight)
    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateHeight)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0
    setScrollTop(0)
  }, [resetKey])
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !viewportHeight || ensureVisibleIndex < 0) return
    const rowTop = ensureVisibleIndex * rowHeight
    const rowBottom = rowTop + rowHeight
    if (rowTop < viewport.scrollTop) viewport.scrollTop = rowTop
    else if (rowBottom > viewport.scrollTop + viewportHeight) viewport.scrollTop = rowBottom - viewportHeight
  }, [ensureVisibleIndex, rowHeight, viewportHeight])
  const shouldVirtualize = viewportHeight > 0 && rows.length * rowHeight > viewportHeight * 2
  const start = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / rowHeight) - 8) : 0
  const end = shouldVirtualize
    ? Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 8)
    : rows.length
  return (
    <div ref={viewportRef} className={className} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="relative" style={{ height: `${rows.length * rowHeight}px` }}>
        {rows.slice(start, end).map((row, index) => (
          <div
            key={start + index}
            className="absolute left-0 right-0 overflow-hidden"
            style={{ top: `${(start + index) * rowHeight}px`, height: `${rowHeight}px` }}
          >
            {row}
          </div>
        ))}
      </div>
    </div>
  )
}
function FavoriteDirectoryButton({
  active,
  name,
  onClick,
}: {
  active: boolean
  name: string
  onClick: (event: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-apple px-1 py-0 text-caption leading-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${active ? 'bg-accent/10 text-accent opacity-100' : 'bg-bg-2 text-text-3 hover:text-text-1'}`}
      aria-label={`${active ? 'Unfavorite' : 'Favorite'} ${name}`}
    >
      {active ? '★' : '☆'}
    </button>
  )
}
type FileTreeNode = { key: string; item: FileItem; children?: FileTreeNode[] }
function getTreeRowIndex(nodes: FileTreeNode[], path: string) {
  if (!path) return -1
  const stack = [...nodes].reverse()
  let index = 0
  while (stack.length) {
    const node = stack.pop()!
    if (node.item.path === path) return index
    index += 1
    if (node.children?.length) stack.push(...[...node.children].reverse())
  }
  return -1
}
export type FilePanelPickerTarget = {
  rootId: string
  rootPath: string
  rootLabel: string
  relativePath: string
  absolutePath: string
}
export function FilePanel({
  mode = 'panel',
  dock = 'right',
  onClose,
  onOpenFile,
  onPick,
}: {
  mode?: 'panel' | 'mobile' | 'explorer' | 'picker'
  dock?: 'left' | 'right'
  onClose?: () => void
  onOpenFile?: (file: FileDocumentHandle) => void
  onPick?: (target: FilePanelPickerTarget) => void
}) {
  const queryClient = useQueryClient()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
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
  const isPicker = mode === 'picker'
  const isMobile = mode === 'mobile' || (isPicker && isMobileDevice())
  const sessionWorkspacesQuery = useSessionWorkspaces()
  const sessionWorkspaces = useMemo(() => sessionWorkspacesQuery.data || [], [sessionWorkspacesQuery.data])
  const [selectedRootId, setSelectedRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  // selectedPath = focus 项（跟随所有点击）；selectedPaths = 完整多选集合（VSCode Explorer 语义）
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  // shift+click 区间锚点：仅普通点击/单选更新；ctrl+click 与 shift+click 只动 focus 不动 anchor
  // （VSCode list 语义，见 microsoft/vscode#77575）
  const [selectionAnchor, setSelectionAnchor] = useState('')
  const [selectedPreviewLine, setSelectedPreviewLine] = useState(1)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [fileTypeFilter, setFileTypeFilter] = useState<FileTypeFilter>('all')
  const [fileSort, setFileSort] = useState<FileSort>(readFileSort)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: FileEntry | null
    directoryPath: string
    mobile: boolean
  } | null>(null)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list')
  const [mobileEditOpen, setMobileEditOpen] = useState(false)
  const [mobileEditContent, setMobileEditContent] = useState('')
  const [mobileEditSaved, setMobileEditSaved] = useState('')
  const [mobileEditLoading, setMobileEditLoading] = useState(false)
  const [mobileEditSaving, setMobileEditSaving] = useState(false)
  const [mobileEditConfirm, setMobileEditConfirm] = useState<null | 'enter' | 'exit'>(null)
  const [mobileFileContent, setMobileFileContent] = useState<string | null>(null)
  const [mobileSourceView, setMobileSourceView] = useState(false)
  const [favoriteDirectories, setFavoriteDirectories] = useState<FavoriteDirectory[]>([])
  // 已取消但暂留显示的收藏项（key=`rootId:path`），host 切换或重载时清空
  const [unfavoritedEntries, setUnfavoritedEntries] = useState<Map<string, FavoriteDirectory>>(new Map())
  const [contentReady] = useState(true)
  const [hideDotFiles, setHideDotFiles] = useState(readHideDotFiles)
  const [followActivePath, setFollowActivePath] = useState(readFollowActivePath)
  const [openDirectories, setOpenDirectories] = useState<Set<string>>(new Set())
  const [searchNavigationPath, setSearchNavigationPath] = useState<string | null>(null)
  const [directoryCache, setDirectoryCache] = useState<Map<string, FileItem[]>>(new Map())
  const [directoryStatus, setDirectoryStatusState] = useState<Map<string, DirectoryStatus>>(new Map())
  const resizingRef = useRef(false)
  const pendingWidthRef = useRef(filePanelWidth)
  const frameRef = useRef<number | null>(null)
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const directoryLoadingRef = useRef<Map<string, Promise<FileItem[]>>>(new Map())
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextMenuRef = useRef(false)
  const pendingSheetCloseAfterDiscardRef = useRef(false)
  const currentPathRef = useRef('')
  const mobileNavigationDepthRef = useRef(0)
  // 跟随终端目录的返回锚点:跟随落到的 pane cwd 作为系统返回的"根目录",
  // 到达该层后再次返回直接关闭文件 tab;越过它(面板内 ‹ 上一级)亦同
  const mobileNavFloorRef = useRef<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const lastFollowedEditorKeyRef = useRef('')
  // 跟随时手动导航（收藏目录/根切换/上下级）先挂起跟随，等切换到别的 pane 再恢复
  const [followSuspended, setFollowSuspended] = useState(false)
  const lastAppliedWorkspaceSessionRef = useRef<string | undefined>(undefined)
  const [pendingDeleteItems, setPendingDeleteItems] = useState<FileEntry[]>([])
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [lastTrashedItem, setLastTrashedItem] = useState<TrashEntry | null>(null)
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([])
  const [trashOpen, setTrashOpen] = useState(false)
  const [fileClipboard, setFileClipboard] = useState<{
    hostId: string
    rootId: string
    path: string
    itemPath: string
    name: string
    move: boolean
  } | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState('')
  const virtualRoots = useMemo(
    () =>
      favoriteDirectories.map((item) => ({
        id: getFavoriteRootOptionId(item),
        label: item.name,
        path: joinPath(item.rootPath, item.path),
        sourceRootId: item.rootId,
        basePath: item.path,
      })),
    [favoriteDirectories],
  )
  const visibleRoots = useMemo(() => {
    const workspace = roots.find((item) => getRootKind(item) === 'workspace') || null
    const home = roots.find((item) => getRootKind(item) === 'home') || null
    const pinned = [workspace, home].filter((item): item is FileRoot => !!item)
    const extras = roots.filter((item) => !pinned.some((entry) => entry.id === item.id))
    return pinned.length ? [...pinned, ...extras] : roots
  }, [roots])
  const rootOptions = useMemo(
    () => [...visibleRoots.map((item) => ({ ...item, sourceRootId: item.id, basePath: '' })), ...virtualRoots],
    [visibleRoots, virtualRoots],
  )
  const activeRoot = rootOptions.find((item) => item.id === selectedRootId) || rootOptions[0]
  const activeRootId = activeRoot?.sourceRootId || ''
  const activeRootBasePath = activeRoot?.basePath || ''
  const activeSourceRootPath =
    visibleRoots.find((item) => item.id === activeRootId)?.path ||
    roots.find((item) => item.id === activeRootId)?.path ||
    activeRoot?.path ||
    ''
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
  const { data: rawSearchResults = [], isFetching: searchLoading } = useFileSearch(
    fileHostId,
    activeRootId,
    searchMode,
    debouncedQuery,
    searchBasePath,
    !hideDotFiles,
  )
  const followPaneId = followActivePath && activePaneId?.startsWith(`${fileHostId}:`) ? activePaneId : null
  const { data: activePaneCwd } = usePaneCwd(followPaneId, !isPicker)
  // pane 切换即恢复跟随
  const prevFollowPaneIdRef = useRef(followPaneId)
  useEffect(() => {
    if (prevFollowPaneIdRef.current === followPaneId) return
    prevFollowPaneIdRef.current = followPaneId
    setFollowSuspended(false)
  }, [followPaneId])
  const root = activeRoot
  const listData = useMemo(() => rebaseListData(rawListData, activeRoot), [rawListData, activeRoot])
  const preview = useMemo(() => rebasePreview(rawPreview, activeRootBasePath), [rawPreview, activeRootBasePath])
  const mobileEditDirty = mobileEditOpen && mobileEditContent !== mobileEditSaved
  const mobileEditable =
    isMobile &&
    mobileView === 'preview' &&
    !!preview &&
    preview.type === 'file' &&
    !preview.binary &&
    !preview.truncated &&
    !preview.reason
  // 手机端默认渲染视图:md→markdown/html→iframe/csv→表格,其余文本走源码行号;
  // 图片/svg 走 imagePreviewPath 分支天然渲染
  const mobileRenderKind = useMemo<'markdown' | 'html' | 'csv' | null>(() => {
    if (!isMobile || mobileView !== 'preview' || !selectedPath || !preview) return null
    if (preview.type !== 'file' || preview.binary || preview.reason) return null
    const lower = selectedPath.toLowerCase()
    if (lower.endsWith('.md')) return 'markdown'
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
    if (lower.endsWith('.csv')) return 'csv'
    return null
  }, [isMobile, mobileView, preview, selectedPath])
  const searchResults = useMemo(
    () => rawSearchResults.slice(0, SEARCH_RESULT_LIMIT).map((item) => rebaseEntryPath(item, activeRootBasePath)),
    [rawSearchResults, activeRootBasePath],
  )
  const rootLabelById = useMemo(
    () => Object.fromEntries(visibleRoots.map((item) => [item.id, item.label])),
    [visibleRoots],
  )
  const rootPathById = useMemo(
    () => Object.fromEntries(visibleRoots.map((item) => [item.id, item.path])),
    [visibleRoots],
  )
  // 上一级目标：普通情况取 currentPath 父目录；位于收藏虚拟根时取其源 root 内收藏路径的父目录
  const parentDirectory = useMemo(() => {
    if (currentPath) {
      const parent = getParentPath(currentPath)
      return {
        rootOptionId: activeRoot?.id || '',
        path: parent,
        label: joinPath(activeSourceRootPath, joinRelativePath(activeRootBasePath, parent)),
      }
    }
    if (activeFavorite) {
      const parent = getParentPath(activeFavorite.path)
      return {
        rootOptionId: activeFavorite.rootId,
        path: parent,
        label: joinPath(rootPathById[activeFavorite.rootId] || activeFavorite.rootPath, parent),
      }
    }
    return null
  }, [activeFavorite, activeRoot?.id, activeRootBasePath, activeSourceRootPath, currentPath, rootPathById])
  const activeEditor = useMemo(
    () => (activeEditorId ? openEditors.find((item) => item.id === activeEditorId) || null : null),
    [activeEditorId, openEditors],
  )
  const isSearching = debouncedQuery.trim().length > 0
  const showSearchResults = isSearching && !searchNavigationPath
  const items = useMemo(
    () => (showSearchResults ? searchResults : listData?.items || []),
    [listData?.items, searchResults, showSearchResults],
  )
  const visibleItems = useMemo(() => {
    const filtered = items.filter(
      (item: any) =>
        (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter),
    )
    if (showSearchResults) return filtered
    return [...filtered].sort((a, b) => compareFileItems(a, b, fileSort))
  }, [fileTypeFilter, fileSort, hideDotFiles, items, showSearchResults])
  const visibleFavoriteDirectories = useMemo(() => {
    const hidden = (item: FavoriteDirectory) => hideDotFiles && isDotPath(item.path)
    const pending = Array.from(unfavoritedEntries.values()).filter(
      (item) =>
        !hidden(item) && !favoriteDirectories.some((entry) => entry.rootId === item.rootId && entry.path === item.path),
    )
    return [...favoriteDirectories.filter((item) => !hidden(item)), ...pending]
  }, [hideDotFiles, favoriteDirectories, unfavoritedEntries])
  const storeDirectoryChildren = useCallback(
    (rootId: string, rootBasePath: string, itemPath: string, items: FileItem[]) => {
      setDirectoryCache((current) => {
        const next = new Map(current)
        next.set(getDirectoryCacheKey(rootId, rootBasePath, itemPath), items)
        return next
      })
    },
    [],
  )
  const setDirectoryStatus = useCallback(
    (rootId: string, rootBasePath: string, itemPath: string, status: DirectoryStatus | null) => {
      setDirectoryStatusState((current) => {
        const next = new Map(current)
        const key = getDirectoryCacheKey(rootId, rootBasePath, itemPath)
        if (status) next.set(key, status)
        else next.delete(key)
        return next
      })
    },
    [],
  )
  const loadDirectoryChildren = useCallback(
    async (item: FileItem) => {
      const cacheKey = getDirectoryCacheKey(activeRootId, activeRootBasePath, item.path)
      const cache = directoryCache.get(cacheKey)
      if (cache) return cache
      const pending = directoryLoadingRef.current.get(cacheKey)
      if (pending) return pending
      setDirectoryStatus(activeRootId, activeRootBasePath, item.path, { state: 'loading', message: '' })
      const request = api.files
        .list(fileHostId, activeRootId, joinRelativePath(activeRootBasePath, item.path))
        .then((result) => {
          const nextItems = result.items.map((entry) => rebaseEntryPath(entry, activeRootBasePath))
          storeDirectoryChildren(activeRootId, activeRootBasePath, item.path, nextItems)
          setDirectoryStatus(activeRootId, activeRootBasePath, item.path, null)
          return nextItems
        })
        .catch((err) => {
          setDirectoryStatus(activeRootId, activeRootBasePath, item.path, {
            state: 'error',
            message: err instanceof Error ? err.message : t('file.treeLoadFailed'),
          })
          return []
        })
        .finally(() => {
          directoryLoadingRef.current.delete(cacheKey)
        })
      directoryLoadingRef.current.set(cacheKey, request)
      try {
        return await request
      } catch {
        return []
      }
    },
    [activeRootBasePath, activeRootId, directoryCache, fileHostId, setDirectoryStatus, storeDirectoryChildren, t],
  )
  const createTreeNodes = useCallback(
    (items: FileItem[]): FileTreeNode[] =>
      items
        .filter(
          (item) =>
            (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter),
        )
        .sort((a, b) => compareFileItems(a, b, fileSort))
        .map((item) => {
          const children =
            item.type === 'directory' && openDirectories.has(item.path)
              ? readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path)
              : undefined
          return { key: item.path, children: children ? createTreeNodes(children) : undefined, item }
        }),
    [activeRootBasePath, activeRootId, directoryCache, fileSort, fileTypeFilter, hideDotFiles, openDirectories],
  )
  const desktopTreeData = useMemo(
    () => (!isMobile && !showSearchResults ? createTreeNodes(listData?.items || []) : []),
    [createTreeNodes, isMobile, listData?.items, showSearchResults],
  )
  // 可见行扁平序：shift 区间/方向键/Ctrl+A 以此为准（DOM 序不可靠——VirtualizedRows 只渲染视窗内行）
  const flatVisibleItems = useMemo((): FileEntry[] => {
    const out: FileEntry[] = []
    const walkTree = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        out.push(node.item)
        if (node.children) walkTree(node.children)
      }
    }
    const walkEntries = (list: FileEntry[]) => {
      for (const item of list) {
        if ((hideDotFiles && isDotPath(item.path || item.name)) || !matchesFileTypeFilter(item, fileTypeFilter))
          continue
        out.push(item)
        if (item.type === 'directory' && openDirectories.has(item.path)) {
          const children = readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path)
          if (children) walkEntries(children)
        }
      }
    }
    if (isMobile || isPicker) out.push(...visibleItems)
    else if (showSearchResults) walkEntries(visibleItems)
    else walkTree(desktopTreeData)
    return out
  }, [
    activeRootBasePath,
    activeRootId,
    desktopTreeData,
    directoryCache,
    fileTypeFilter,
    hideDotFiles,
    isMobile,
    isPicker,
    openDirectories,
    showSearchResults,
    visibleItems,
  ])
  // 选中项可能位于折叠目录的缓存里：批量操作与存在性清理用全量已知项，而非仅可见行
  const knownItemByPath = useMemo(() => {
    const map = new Map<string, FileEntry>()
    for (const item of flatVisibleItems) map.set(item.path, item)
    for (const items of directoryCache.values()) for (const item of items) map.set(item.path, item)
    return map
  }, [flatVisibleItems, directoryCache])
  const selectedItems = useMemo(
    () => [...selectedPaths].map((path) => knownItemByPath.get(path)).filter((i): i is FileEntry => !!i),
    [selectedPaths, knownItemByPath],
  )
  // 删除/刷新后清理 selection：仅保留仍存在于可见行或目录缓存中的项
  useEffect(() => {
    setSelectedPaths((current) => {
      if (!current.size) return current
      let changed = false
      const next = new Set<string>()
      for (const path of current) {
        if (knownItemByPath.has(path)) next.add(path)
        else changed = true
      }
      return changed ? next : current
    })
    if (selectionAnchor && !knownItemByPath.has(selectionAnchor)) setSelectionAnchor('')
  }, [knownItemByPath, selectionAnchor])

  useEffect(() => {
    if (!selectedRootId && rootOptions[0]) setSelectedRootId(rootOptions[0].id)
  }, [rootOptions, selectedRootId])
  useEffect(() => {
    currentPathRef.current = ''
    mobileNavigationDepthRef.current = 0
    mobileNavFloorRef.current = null
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
    setDirectoryStatusState(new Map())
    lastFollowedEditorKeyRef.current = ''
    setFollowSuspended(false)
    lastAppliedWorkspaceSessionRef.current = undefined
    directoryLoadingRef.current.clear()
    setSelectedPaths(new Set())
    setSelectionAnchor('')
    setFileClipboard(null)
    setUnfavoritedEntries(new Map())
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
  // 切 session 不再重置文件区；跟随行为统一由底部"跟随激活路径"开关控制
  useEffect(() => {
    if (!followActivePath || isPicker || mode === 'explorer') return
    if (isSearching) return
    if (!activeSessionId || !rootOptions.length) return
    if (lastAppliedWorkspaceSessionRef.current === activeSessionId) return
    if (sessionWorkspacesQuery.isFetching) return
    const entry = sessionWorkspaces.find((item) => item.sessionId === activeSessionId)
    lastAppliedWorkspaceSessionRef.current = activeSessionId
    if (!entry) return
    const matchedRoot = rootOptions.find((item) => item.sourceRootId === entry.rootId && item.basePath === '')
    if (!matchedRoot) return
    if (selectedRootId !== matchedRoot.id) setSelectedRootId(matchedRoot.id)
    const nextPath = entry.relativePath || ''
    if (currentPath !== nextPath) {
      currentPathRef.current = nextPath
      setCurrentPath(nextPath)
    }
  }, [
    activeSessionId,
    followActivePath,
    rootOptions,
    sessionWorkspaces,
    sessionWorkspacesQuery.isFetching,
    isSearching,
    isPicker,
    mode,
    selectedRootId,
    currentPath,
  ])
  useEffect(() => {
    if (!openDirectories.size) return
    for (const itemPath of Array.from(openDirectories)) {
      if (readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, itemPath)) continue
      if (readDirectoryStatusFromCache(directoryStatus, activeRootId, activeRootBasePath, itemPath)?.state === 'error')
        continue
      const cacheKey = getDirectoryCacheKey(activeRootId, activeRootBasePath, itemPath)
      if (directoryLoadingRef.current.has(cacheKey)) continue
      void loadDirectoryChildren({
        name: getDirectoryName(itemPath, activeRoot || roots[0] || { id: '', label: '', path: '' }),
        path: itemPath,
        type: 'directory',
        size: 0,
        modifiedAt: '',
      })
    }
  }, [
    activeRoot,
    activeRootBasePath,
    activeRootId,
    directoryCache,
    directoryStatus,
    loadDirectoryChildren,
    openDirectories,
    roots,
  ])
  useEffect(() => {
    if (!roots.length) return
    const localEntries = readFavoriteDirectories()
    const sanitizedLocalEntries = sanitizeFavoriteDirectories(localEntries, roots)
    if (!areFavoriteDirectoriesEqual(localEntries, sanitizedLocalEntries))
      writeFavoriteDirectories(sanitizedLocalEntries)
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
          await api.preferences.update(
            { favoriteDirectories: sanitizedLocalEntries, favoriteDirectoriesUpdatedAt: pushedAt },
            PREFERENCES_PROFILE,
          )
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          writeFavoriteDirectories(remoteEntries, remoteUpdatedAt || new Date().toISOString())
          setFavoriteDirectories(remoteEntries)
          if (!areFavoriteDirectoriesEqual(remoteEntriesRaw, remoteEntries))
            await api.preferences.update(
              {
                favoriteDirectories: remoteEntries,
                favoriteDirectoriesUpdatedAt: remoteUpdatedAt || new Date().toISOString(),
              },
              PREFERENCES_PROFILE,
            )
          return
        }
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs)) {
          await api.preferences.update(
            { favoriteDirectories: sanitizedLocalEntries, favoriteDirectoriesUpdatedAt: localUpdatedAt },
            PREFERENCES_PROFILE,
          )
        }
      } catch {}
    })()
  }, [roots])
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      pendingWidthRef.current = Math.max(200, Math.min(520, window.innerWidth - e.clientX))
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setPreviewWidth(pendingWidthRef.current)
      })
    }
    const handleUp = () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizingRef.current) {
        setFilePanelWidth(pendingWidthRef.current)
        setPreviewWidth(null)
        emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      }
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    // 窗口失焦时 mouseup 不会送达，必须结算否则 gesture end 丢失、burst 抑制卡住
    window.addEventListener('blur', handleUp)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      // 卸载兜底：拖拽中组件消失时补 end，否则 PaneGrid 的 burst 抑制永久卡住
      if (resizingRef.current) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('blur', handleUp)
    }
  }, [setFilePanelWidth])
  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])
  useEffect(() => {
    contextMenuRef.current = !!contextMenu
  }, [contextMenu])
  const pushMobileNavigationHistory = () => {
    if (!isMobile || typeof window === 'undefined') return
    mobileNavigationDepthRef.current += 1
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-push-level'))
  }
  const goMobileParentDirectory = () => {
    setFollowSuspended(true)
    const parts = currentPathRef.current.split(/[\\/]+/).filter(Boolean)
    const nextPath = parts.slice(0, -1).join('/')
    currentPathRef.current = nextPath
    setCurrentPath(nextPath)
    setSelectedPath('')
    setSelectedPaths(new Set())
    setSelectionAnchor('')
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
      if (contextMenuRef.current) {
        detail.handled = true
        setContextMenu(null)
        return
      }
      if (mobileView === 'preview') {
        detail.handled = true
        if (mobileEditOpen && mobileEditContent !== mobileEditSaved) setMobileEditConfirm('exit')
        else setMobileView('list')
        return
      }
      if (!currentPathRef.current) return
      // 跟随锚点之上不再上溯:位于锚点本身或锚点上方(面板 ‹ 上一级越过去)
      // 时放行,由 sheet 层关闭文件 tab;锚点之下正常逐级上溯
      const floor = followActivePath ? mobileNavFloorRef.current : null
      if (floor && !currentPathRef.current.startsWith(`${floor}/`)) return
      detail.handled = true
      mobileNavigationDepthRef.current = Math.max(0, mobileNavigationDepthRef.current - 1)
      goMobileParentDirectory()
    }
    window.addEventListener('tmuxgo-mobile-files-back', handleBack as EventListener)
    return () => window.removeEventListener('tmuxgo-mobile-files-back', handleBack as EventListener)
  }, [followActivePath, isMobile, mobileEditContent, mobileEditOpen, mobileEditSaved, mobileView])
  useEffect(() => {
    setMobileEditOpen(false)
    setMobileEditContent('')
    setMobileEditSaved('')
    setMobileEditConfirm(null)
    setMobileSourceView(false)
  }, [mobileView, selectedPath])
  const switchRoot = (nextRootId: string) => {
    setSelectedRootId(nextRootId)
    currentPathRef.current = ''
    mobileNavigationDepthRef.current = 0
    mobileNavFloorRef.current = null
    setCurrentPath('')
    setSelectedPath('')
    setSelectedPaths(new Set())
    setSelectionAnchor('')
    setSelectedPreviewLine(1)
    setMobileView('list')
    setOpenDirectories(new Set())
    setSearchNavigationPath(null)
    setDirectoryCache(new Map())
    setDirectoryStatusState(new Map())
    directoryLoadingRef.current.clear()
  }
  const openDirectoryShortcut = (entry: { rootId: string; path: string }) => {
    setFollowSuspended(true)
    const nextRootId = getFavoriteRootOptionId(entry)
    setSelectedRootId(nextRootId)
    // 收藏虚拟根必须无条件从自身 basePath 列起——否则从收藏 A 返回上一级后
    // currentPath 残留 A 的父目录，点收藏 B 会拼出 baseB+父A 的不存在路径，
    // 触发 useFileList retry 指数退避卡数秒（远端 SSH 往返更慢）
    currentPathRef.current = ''
    setCurrentPath('')
    if (isMobile) {
      mobileNavigationDepthRef.current = 0
    } else {
      setOpenDirectories(new Set())
      setDirectoryStatusState(new Map())
    }
    setSelectedPath('')
    setSelectedPaths(new Set())
    setSelectionAnchor('')
    setSelectedPreviewLine(1)
    setMobileView('list')
    setSearchNavigationPath(null)
  }
  const goParentDirectory = () => {
    if (!parentDirectory) return
    setFollowSuspended(true)
    // 移动端已按目录进入推送过 history，返回需走 history.back() 让栈与 UI 同步
    if (isMobile && currentPath && mobileNavigationDepthRef.current > 0) {
      window.history.back()
      return
    }
    // 收藏虚拟根的上一级在其源 root 内：切回源 root 并落到收藏路径的父目录
    if (parentDirectory.rootOptionId !== selectedRootId) {
      switchRoot(parentDirectory.rootOptionId)
      currentPathRef.current = parentDirectory.path
      setCurrentPath(parentDirectory.path)
      return
    }
    goMobileParentDirectory()
  }
  const isFavoriteDirectory = (entry: { rootId: string; path: string }) =>
    favoriteDirectories.some((item) => item.rootId === entry.rootId && item.path === entry.path)
  const favoriteKeyOf = (entry: { rootId: string; path: string }) => `${entry.rootId}:${entry.path}`
  const markUnfavorited = (entry: FavoriteDirectory) =>
    setUnfavoritedEntries((current) => new Map(current).set(favoriteKeyOf(entry), entry))
  const unmarkUnfavorited = (entry: { rootId: string; path: string }) =>
    setUnfavoritedEntries((current) => {
      if (!current.has(favoriteKeyOf(entry))) return current
      const next = new Map(current)
      next.delete(favoriteKeyOf(entry))
      return next
    })
  const persistFavoriteDirectories = (next: { entries: FavoriteDirectory[]; updatedAt: string }) => {
    setFavoriteDirectories(next.entries)
    void api.preferences
      .update({ favoriteDirectories: next.entries, favoriteDirectoriesUpdatedAt: next.updatedAt }, PREFERENCES_PROFILE)
      .catch(() => {})
  }
  const toggleFavoriteDirectory = (item: FileItem) => {
    if (!root) return
    const nextRootId = activeRoot?.sourceRootId || ''
    const nextRootPath = roots.find((entry) => entry.id === nextRootId)?.path || root.path
    const nextPath = joinRelativePath(activeRootBasePath, item.path)
    const nextName = getDirectoryName(nextPath, { ...root, path: nextRootPath })
    const entry: FavoriteDirectory = {
      rootId: nextRootId,
      rootPath: nextRootPath,
      name: nextName,
      path: nextPath,
    }
    const wasFavorite = isFavoriteDirectory(entry)
    persistFavoriteDirectories(toggleFavoriteDirectoryEntry(entry))
    // 取消侧进暂留列表，让收藏区行变空心而非立刻消失；收藏侧清掉暂留
    if (wasFavorite) markUnfavorited(entry)
    else unmarkUnfavorited(entry)
  }
  const removeFavoriteDirectory = (entry: FavoriteDirectory) => {
    persistFavoriteDirectories(removeFavoriteDirectoryEntry(entry))
    markUnfavorited(entry)
    // 取消的正是当前打开的收藏虚拟根：落回源 root 的同路径，避免 reconcile 弹回 roots[0]
    if (selectedRootId === getFavoriteRootOptionId(entry)) {
      switchRoot(entry.rootId)
      currentPathRef.current = entry.path
      setCurrentPath(entry.path)
    }
  }
  const toggleFavoriteAreaEntry = (item: FavoriteDirectory) => {
    if (isFavoriteDirectory(item)) removeFavoriteDirectory(item)
    else {
      persistFavoriteDirectories(toggleFavoriteDirectoryEntry(item))
      unmarkUnfavorited(item)
    }
  }
  // —— VSCode Explorer 选择语义 ——
  const selectSinglePath = (path: string) => {
    setSelectedPath(path)
    setSelectionAnchor(path)
    setSelectedPaths(path ? new Set([path]) : new Set())
  }
  // ctrl+click：切换该项选中态并更新 focus；不动 anchor、不打开文件、不动目录展开（展开交给 ▸）
  const toggleItemSelection = (item: FileEntry) => {
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })
    setSelectedPath(item.path)
  }
  // shift+click：selection 替换为 anchor→目标项的可见序区间（VSCode 是 setSelection 而非并入）；
  // focus 跟随目标项，anchor 保持不动；无 anchor 退化为单选
  const selectRangeTo = (item: FileEntry) => {
    const order = flatVisibleItems.map((entry) => entry.path)
    const targetIndex = order.indexOf(item.path)
    const anchorIndex = order.indexOf(selectionAnchor)
    if (targetIndex < 0 || anchorIndex < 0) {
      selectSinglePath(item.path)
      return
    }
    const [lo, hi] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    setSelectedPaths(new Set(order.slice(lo, hi + 1)))
    setSelectedPath(item.path)
  }
  // 行点击分流：返回 true 表示已被多选手势消费（不执行打开/展开动作）
  const applyRowSelectGesture = (item: FileEntry, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.shiftKey) {
      selectRangeTo(item)
      return true
    }
    if (e.ctrlKey || e.metaKey) {
      toggleItemSelection(item)
      return true
    }
    return false
  }
  const handleDesktopDirectoryToggle = (item: FileItem) => {
    let expanding = false
    setOpenDirectories((current) => {
      const next = new Set(current)
      if (next.has(item.path)) next.delete(item.path)
      else {
        next.add(item.path)
        expanding = true
      }
      return next
    })
    if (expanding) void loadDirectoryChildren(item)
    selectSinglePath(item.path)
  }
  // 跟随激活 pane cwd：把绝对路径映射回 rootOption + 相对路径
  const paneCwdFollowTarget = useMemo(() => {
    if (!followActivePath || isPicker || !activePaneCwd || !visibleRoots.length) return null
    const matched = chooseFileRoot(visibleRoots, activePaneCwd)
    if (!matched) return null
    const option = rootOptions.find((item) => item.sourceRootId === matched.id && item.basePath === '')
    const relative = getRootRelativePath(matched.path, activePaneCwd)
    if (!option || relative == null) return null
    return { rootOptionId: option.id, path: relative }
  }, [activePaneCwd, followActivePath, isPicker, rootOptions, visibleRoots])
  useEffect(() => {
    if (!paneCwdFollowTarget || followSuspended) return
    if (selectedRootId !== paneCwdFollowTarget.rootOptionId) switchRoot(paneCwdFollowTarget.rootOptionId)
    // 锚点随跟随落点更新:同路径提前返回前也要先落锚,保证返回楼层存在
    mobileNavFloorRef.current = paneCwdFollowTarget.path
    if (currentPathRef.current === paneCwdFollowTarget.path) return
    currentPathRef.current = paneCwdFollowTarget.path
    mobileNavigationDepthRef.current = 0
    setCurrentPath(paneCwdFollowTarget.path)
  }, [paneCwdFollowTarget, selectedRootId, followSuspended])
  const activeEditorFollowTarget = useMemo(() => {
    if (!activeEditor || activeEditor.kind === 'compare' || activeEditor.hostId !== fileHostId || !rootOptions.length)
      return null
    const matchedRoot = getMatchingRootOption(rootOptions, activeEditor.rootId, activeEditor.path)
    if (!matchedRoot) return null
    const nextPath = stripBasePath(activeEditor.path, matchedRoot.basePath)
    const parentPath = getParentPath(nextPath)
    return {
      key: `${activeEditor.id}:${matchedRoot.id}`,
      rootId: matchedRoot.id,
      path: nextPath,
      parentPath,
      basePath: matchedRoot.basePath,
    }
  }, [activeEditor, fileHostId, rootOptions])
  useEffect(() => {
    if (isMobile || isPicker || !activeEditorFollowTarget) return
    if (activeEditorFollowTarget.rootId !== selectedRootId) {
      // 跟随终端目录时不接管根切换：不同根的文件在当前视图不可见，无需处理
      if (followPaneId) return
      if (lastFollowedEditorKeyRef.current === activeEditorFollowTarget.key) return
      switchRoot(activeEditorFollowTarget.rootId)
      return
    }
    if (followPaneId) {
      // 跟随模式不挪动 currentPath，只高亮落在当前目录视图内的文件
      const parent = activeEditorFollowTarget.parentPath
      if (currentPath && parent !== currentPath && !parent.startsWith(`${currentPath}/`)) return
    }
    if (lastFollowedEditorKeyRef.current === activeEditorFollowTarget.key) return
    lastFollowedEditorKeyRef.current = activeEditorFollowTarget.key
    const nextSearchNavigationPath = query.trim() ? activeEditorFollowTarget.parentPath || '/' : null
    // 非跟随模式回根目录再展开父链，跨目录文件也能高亮；跟随模式保持 cwd 视图不动
    if (!followPaneId) {
      currentPathRef.current = ''
      setCurrentPath('')
    }
    setSelectedPath((value) => (value === activeEditorFollowTarget.path ? value : activeEditorFollowTarget.path))
    // 跟随高亮即单选（VSCode reveal 语义）
    setSelectedPaths((current) =>
      current.size === 1 && current.has(activeEditorFollowTarget.path)
        ? current
        : new Set([activeEditorFollowTarget.path]),
    )
    setSelectedPreviewLine((value) => (value === 1 ? value : 1))
    setSearchNavigationPath((value) => (value === nextSearchNavigationPath ? value : nextSearchNavigationPath))
    setOpenDirectories((current) => {
      const next = new Set(current)
      for (const path of getDirectoryPathChain(activeEditorFollowTarget.parentPath)) next.add(path)
      return current.size === next.size && Array.from(current).every((item) => next.has(item)) ? current : next
    })
    void Promise.all(
      getDirectoryPathChain(activeEditorFollowTarget.parentPath).map((path) =>
        loadDirectoryChildren({
          name: getDirectoryName(path, activeRoot || roots[0] || { id: '', label: '', path: '' }),
          path,
          type: 'directory',
          size: 0,
          modifiedAt: '',
        }),
      ),
    )
  }, [
    activeEditor,
    activeEditorFollowTarget,
    activeRoot,
    currentPath,
    followPaneId,
    isMobile,
    isPicker,
    loadDirectoryChildren,
    query,
    roots,
    selectedRootId,
  ])
  useEffect(() => {
    if (isMobile || showSearchResults || !selectedPath || typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      const element = (document.querySelector('.tmuxgo-file-tree [data-focused="true"]') ||
        document.querySelector('.tmuxgo-file-tree [data-selected="true"]')) as HTMLElement | null
      element?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [desktopTreeData, isMobile, selectedPath, showSearchResults])

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
      type: item.type,
    }
  }
  const bindFileDrag = (item: FileEntry) =>
    isMobile
      ? {}
      : {
          draggable: true,
          onDragStart: (event: React.DragEvent<HTMLElement>) => {
            // 拖已选中项 = 拖整个 selection；拖未选中项 = 单拖（VSCode Explorer 语义）
            const draggedItems = selectedPaths.has(item.path) && selectedItems.length > 1 ? selectedItems : [item]
            const handle: FileDocumentHandle & { items?: FileDocumentHandle[] } = {
              ...createFileHandle(item),
              ...(draggedItems.length > 1 ? { items: draggedItems.map((entry) => createFileHandle(entry)) } : {}),
            }
            setActiveDraggedFile(handle)
            event.dataTransfer.effectAllowed = draggedItems.length > 1 ? 'copyMove' : 'copy'
            event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(handle))
          },
          onDragEnd: () => clearActiveDraggedFile(),
        }
  // 同面板目录 drop：payload.items[] 循环 move；目标为某拖拽目录自身/子级时跳过该项
  const dropMoveItems = async (payload: FileDocumentHandle & { items?: FileDocumentHandle[] }, targetDir: string) => {
    const handles = payload.items?.length ? payload.items : [payload]
    const target = resolveRootRelativePath(activeRootBasePath, targetDir)
    const failed: string[] = []
    let moved = 0
    for (const handle of handles) {
      if (handle.type === 'directory' && (target === handle.path || target.startsWith(`${handle.path}/`))) {
        failed.push(handle.name)
        continue
      }
      try {
        await api.files.move(fileHostId, handle.rootId, handle.path, activeRootId, target)
        moved += 1
      } catch {
        failed.push(handle.name)
      }
    }
    if (moved) refreshFiles()
    if (moved)
      pushToast({
        type: 'success',
        message: moved > 1 ? t('file.movedMany', { count: moved }) : t('file.moved', { name: handles[0]!.name }),
      })
    if (failed.length) pushToast({ type: 'error', message: t('file.moveFailedMany', { count: failed.length }) })
  }
  const bindDirectoryDrop = (item: FileEntry) => {
    if (isMobile || item.type !== 'directory') return {}
    return {
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(FILE_DRAG_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTargetPath(item.path)
      },
      onDragLeave: () => setDropTargetPath((current) => (current === item.path ? null : current)),
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        const payload = readDraggedFile(event.dataTransfer)
        setDropTargetPath(null)
        if (!payload) return
        event.preventDefault()
        event.stopPropagation()
        void dropMoveItems(payload, item.path)
      },
    }
  }
  const bindFavoriteDirectoryDrag = (item: FavoriteDirectory) =>
    isMobile
      ? {}
      : {
          draggable: true,
          onDragStart: (event: React.DragEvent<HTMLElement>) => {
            const handle: FileDocumentHandle = {
              id: `${fileHostId}:${item.rootId}:${item.path}`,
              hostId: fileHostId,
              rootId: item.rootId,
              rootLabel: rootLabelById[item.rootId] || item.name,
              rootPath: item.rootPath,
              path: item.path,
              name: item.name,
              absolutePath: joinPath(item.rootPath, item.path),
              type: 'directory',
            }
            setActiveDraggedFile(handle)
            event.dataTransfer.effectAllowed = 'copy'
            event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(handle))
          },
          onDragEnd: () => clearActiveDraggedFile(),
        }
  const openItem = (item: FileEntry) => {
    if (item.type === 'directory') {
      setFollowSuspended(true)
      if (isPicker) {
        currentPathRef.current = item.path
        setCurrentPath(item.path)
        selectSinglePath('')
        setSelectedPreviewLine(1)
        setSearchNavigationPath(isSearching ? item.path : null)
        return
      }
      // 桌面树/搜索结果：目录普通点击 = 选中 + 展开/收起（选中由 toggle 内部 selectSinglePath 完成）
      if (!isMobile) {
        void handleDesktopDirectoryToggle(item)
        return
      }
      pushMobileNavigationHistory()
      currentPathRef.current = item.path
      setCurrentPath(item.path)
      selectSinglePath('')
      setSelectedPreviewLine(1)
      setMobileView('list')
      setSearchNavigationPath(isSearching ? item.path : null)
      return
    }
    if (isPicker) return
    // 打开文件即单选：selection 收敛为该项，不破坏 preview/编辑器语义
    selectSinglePath(item.path)
    if (!isMobile && openInEditor(item)) return
    if (isMobile) pushMobileNavigationHistory()
    setSelectedPreviewLine(getPreviewLine(item))
    if (isMobile) setMobileView('preview')
  }
  const openMobileEditor = () => setMobileEditConfirm('enter')
  const enterMobileEditor = async () => {
    setMobileEditConfirm(null)
    if (!selectedPath) return
    setMobileEditLoading(true)
    try {
      const data = await api.files.content(
        fileHostId,
        activeRootId,
        resolveRootRelativePath(activeRootBasePath, selectedPath),
      )
      if (data.binary || data.truncated || data.reason) {
        pushToast({ type: 'error', message: t('file.mobileEditUnavailable') })
        return
      }
      setMobileEditContent(data.content)
      setMobileEditSaved(data.content)
      setMobileEditOpen(true)
    } catch {
      pushToast({ type: 'error', message: t('file.mobileEditLoadFailed') })
    } finally {
      setMobileEditLoading(false)
    }
  }
  const saveMobileEditor = async () => {
    if (!selectedPath || mobileEditSaving) return
    setMobileEditSaving(true)
    try {
      const result = await api.files.saveContent(
        fileHostId,
        activeRootId,
        resolveRootRelativePath(activeRootBasePath, selectedPath),
        mobileEditContent,
        preview?.modifiedAt,
      )
      setMobileEditSaved(result.content)
      pushToast({ type: 'success', message: t('editor.saved') })
      void queryClient.invalidateQueries({ queryKey: ['file-preview', fileHostId, activeRootId] })
    } catch (error) {
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('file.mobileEditSaveFailed') })
    } finally {
      setMobileEditSaving(false)
    }
  }
  const closeMobileEditor = () => {
    if (mobileEditDirty) {
      setMobileEditConfirm('exit')
      return
    }
    setMobileEditOpen(false)
  }
  const discardMobileEditor = () => {
    setMobileEditConfirm(null)
    setMobileEditOpen(false)
    setMobileEditContent('')
    setMobileEditSaved('')
    if (pendingSheetCloseAfterDiscardRef.current) {
      pendingSheetCloseAfterDiscardRef.current = false
      ;(onClose || (() => setFilePanelOpen(false)))()
    }
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
    pushToast({
      type: 'success',
      message: result.unavailable ? t('file.relativePathCopiedInApp') : t('file.relativePathCopied'),
    })
  }
  const refreshFiles = useCallback(() => {
    setDirectoryCache(new Map())
    setDirectoryStatusState(new Map())
    directoryLoadingRef.current.clear()
    void queryClient.invalidateQueries({ queryKey: ['file-list', fileHostId, activeRootId] })
    void queryClient.invalidateQueries({ queryKey: ['file-search', fileHostId, activeRootId] })
    void queryClient.invalidateQueries({ queryKey: ['file-preview', fileHostId, activeRootId] })
  }, [activeRootId, fileHostId, queryClient])
  useEffect(() => {
    window.addEventListener('tmuxgo-app-recovered', refreshFiles)
    return () => window.removeEventListener('tmuxgo-app-recovered', refreshFiles)
  }, [refreshFiles])
  const clearExpandedDirectories = () => {
    setOpenDirectories(new Set())
    setDirectoryCache(new Map())
    setDirectoryStatusState(new Map())
    directoryLoadingRef.current.clear()
  }
  const getItemFullPath = (item: FileEntry) => {
    const rootRelativePath = resolveRootRelativePath(activeRootBasePath, item.path)
    return activeSourceRootPath ? joinPath(activeSourceRootPath, rootRelativePath) : rootRelativePath
  }
  const getItemTooltip = (item: FileEntry) => {
    const sizeLabel = item.type === 'directory' ? '—' : formatSize(item.size)
    const modifiedLabel = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : '—'
    const detail = `${t('file.type')}: ${item.type === 'directory' ? t('file.dir') : t('file.file')} · ${t('file.size')}: ${sizeLabel} · ${t('file.modified')}: ${modifiedLabel}`
    return `${getItemFullPath(item)}\n${detail}\n${t('file.permission')}: ${formatModeBits(item.mode, item.type)}`
  }
  const startDownload = (item: FileItem | FileContentMatch) => {
    void api.files
      .downloadTask(
        fileHostId,
        activeRootId,
        resolveRootRelativePath(activeRootBasePath, item.path),
        preferences.downloadRateLimitKBps,
      )
      .then(() => {
        pushToast({ type: 'success', message: t('tasks.queued') })
      })
      .catch((error) => {
        pushToast({ type: 'error', message: error instanceof Error ? error.message : t('file.downloadFailed') })
      })
  }
  const createEntry = async (kind: 'file' | 'directory', directoryPath: string) => {
    const name = await prompt(kind === 'file' ? t('file.newFileName') : t('file.newFolderName'), '')
    if (!name?.trim()) return
    try {
      if (kind === 'file')
        await api.files.createFile(
          fileHostId,
          activeRootId,
          joinRelativePath(activeRootBasePath, directoryPath),
          name.trim(),
        )
      else
        await api.files.createDirectory(
          fileHostId,
          activeRootId,
          joinRelativePath(activeRootBasePath, directoryPath),
          name.trim(),
        )
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
      const result = await api.files.rename(
        fileHostId,
        activeRootId,
        resolveRootRelativePath(activeRootBasePath, item.path),
        name.trim(),
      )
      const renamedPath = stripBasePath(result.item.path, activeRootBasePath)
      if (selectedPath === item.path) setSelectedPath(renamedPath)
      if (selectionAnchor === item.path) setSelectionAnchor(renamedPath)
      // selection 里的旧路径同步映射到新路径
      setSelectedPaths((current) => {
        if (!current.has(item.path)) return current
        const next = new Set(current)
        next.delete(item.path)
        next.add(renamedPath)
        return next
      })
      refreshFiles()
      pushToast({ type: 'success', message: t('file.renamed', { name: item.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.renameFailed') })
    }
  }
  // 批量 copy/move：目标目录只提示一次，失败项汇总后一次性 toast
  const transferItems = async (items: FileEntry[], move: boolean) => {
    const targetPath = await prompt(
      t('file.targetDirectory'),
      getParentRelativePath(items[0] || ({ path: '' } as FileEntry), currentPath),
    )
    if (targetPath === null || !items.length) return
    const target = resolveRootRelativePath(activeRootBasePath, targetPath.trim())
    const call = move ? api.files.move : api.files.copy
    const failed: string[] = []
    let done = 0
    for (const item of items) {
      try {
        await call(
          fileHostId,
          activeRootId,
          resolveRootRelativePath(activeRootBasePath, item.path),
          activeRootId,
          target,
        )
        done += 1
      } catch {
        failed.push(item.name)
      }
    }
    if (done) refreshFiles()
    if (failed.length) pushToast({ type: 'error', message: t('file.transferFailedMany', { count: failed.length }) })
    else
      pushToast({
        type: 'success',
        message:
          items.length > 1
            ? t(move ? 'file.movedMany' : 'file.copiedMany', { count: done })
            : t(move ? 'file.moved' : 'file.copied', { name: items[0]!.name }),
      })
  }
  const removeSelection = () => {
    const items = selectedItems.length ? selectedItems : selectedItem ? [selectedItem] : []
    if (items.length) setPendingDeleteItems(items)
  }
  const confirmRemoveItem = async () => {
    const items = pendingDeleteItems
    if (!items.length) return
    setPendingDeleteItems([])
    const removedPaths = new Set<string>()
    const failed: string[] = []
    let lastEntry: TrashEntry | null = null
    for (const item of items) {
      try {
        const result = await api.files.trash(
          fileHostId,
          activeRootId,
          resolveRootRelativePath(activeRootBasePath, item.path),
        )
        lastEntry = result.entry
        removedPaths.add(item.path)
      } catch {
        failed.push(item.name)
      }
    }
    if (lastEntry) setLastTrashedItem(lastEntry)
    if (removedPaths.size) {
      // 失效目录缓存（自身及子级），防止已删项经缓存“复活”进 knownItemByPath
      setDirectoryCache((current) => {
        const next = new Map(current)
        for (const key of [...next.keys()]) {
          if (
            [...removedPaths].some((p) => {
              const joined = joinRelativePath(activeRootBasePath, p)
              return key.endsWith(`:${joined}`) || key.includes(`:${joined}/`)
            })
          ) {
            next.delete(key)
          }
        }
        return next
      })
      setSelectedPaths((current) => new Set([...current].filter((path) => !removedPaths.has(path))))
      if (removedPaths.has(selectionAnchor)) setSelectionAnchor('')
      if (removedPaths.has(selectedPath)) {
        setSelectedPath('')
        setSelectedPreviewLine(1)
      }
      refreshFiles()
    }
    if (failed.length)
      pushToast({
        type: 'error',
        message: t('file.deleteFailedMany', { count: failed.length, names: failed.join(', ') }),
      })
    else
      pushToast({
        type: 'success',
        message:
          items.length > 1
            ? t('file.movedToTrashMany', { count: items.length })
            : t('file.movedToTrash', { name: items[0]!.name }),
      })
  }
  const openTrash = async () => {
    try {
      const result = await api.files.trashEntries(fileHostId)
      setTrashEntries(result.entries)
      setTrashOpen(true)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.deleteFailed') })
    }
  }
  const restoreTrash = async (entry: TrashEntry) => {
    try {
      await api.files.restore(fileHostId, entry.id)
      setTrashEntries((current) => current.filter((item) => item.id !== entry.id))
      if (lastTrashedItem?.id === entry.id) setLastTrashedItem(null)
      refreshFiles()
      pushToast({ type: 'success', message: t('file.restored', { name: entry.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.deleteFailed') })
    }
  }
  const showContextMenu = (x: number, y: number, item: FileEntry | null, directoryPath: string) => {
    setContextMenu({ x, y, item, directoryPath, mobile: isMobile })
  }
  // 树模式下选中项可能在已展开目录的子级缓存里，需展开全量节点查找
  const selectedItem = useMemo(() => {
    if (!selectedPath) return null
    const stack = [...desktopTreeData]
    while (stack.length) {
      const node = stack.pop()!
      if (node.item.path === selectedPath) return node.item
      if (node.children) stack.push(...node.children)
    }
    return visibleItems.find((item) => item.path === selectedPath) || null
  }, [desktopTreeData, selectedPath, visibleItems])
  const pasteFileClipboard = async () => {
    const clip = fileClipboard
    if (!clip || clip.hostId !== fileHostId) return
    const targetDir =
      selectedItem?.type === 'directory'
        ? selectedItem.path
        : selectedItem
          ? getParentPath(selectedItem.path)
          : currentPath
    try {
      const call = clip.move ? api.files.move : api.files.copy
      const result = await call(
        fileHostId,
        clip.rootId,
        clip.path,
        activeRootId,
        resolveRootRelativePath(activeRootBasePath, targetDir),
      )
      if (clip.move) setFileClipboard(null)
      refreshFiles()
      pushToast({ type: 'success', message: t(clip.move ? 'file.moved' : 'file.copied', { name: result.item.name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('file.transferFailed') })
    }
  }
  // 对齐 VSCode Explorer：列表聚焦时支持文件级快捷键
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('input,textarea,select,[contenteditable="true"]')) return
    if (contextMenu || pendingDeleteItems.length) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (e.key === 'F5' || (mod && key === 'r')) {
      e.preventDefault()
      refreshFiles()
      return
    }
    // Ctrl+A：全选可见行（目录行也计入）
    if (mod && key === 'a' && !isMobile) {
      e.preventDefault()
      const paths = flatVisibleItems.map((item) => item.path)
      setSelectedPaths(new Set(paths))
      if (!paths.includes(selectedPath)) setSelectedPath(paths[0] || '')
      return
    }
    if (mod && key === 'z' && !e.shiftKey) {
      if (lastTrashedItem) {
        e.preventDefault()
        void restoreTrash(lastTrashedItem)
      }
      return
    }
    if (mod && key === 'v') {
      if (fileClipboard) {
        e.preventDefault()
        void pasteFileClipboard()
      }
      return
    }
    if (!selectedItem && !selectedPaths.size) return
    if (selectedItem && mod && (key === 'c' || key === 'x')) {
      e.preventDefault()
      const move = key === 'x'
      setFileClipboard({
        hostId: fileHostId,
        rootId: activeRootId,
        path: resolveRootRelativePath(activeRootBasePath, selectedItem.path),
        itemPath: selectedItem.path,
        name: selectedItem.name,
        move,
      })
      pushToast({
        type: 'success',
        message: t(move ? 'file.markedCut' : 'file.markedCopy', { name: selectedItem.name }),
      })
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      removeSelection()
      return
    }
    if (e.key === 'F2' && selectedItem) {
      e.preventDefault()
      void renameItem(selectedItem)
    }
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
  const updateFileSort = (field: SortField) => {
    const next: FileSort =
      field === fileSort.field
        ? { field, direction: fileSort.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' }
    setFileSort(next)
    writeFileSort(next)
  }
  const toggleSortDirection = () => {
    const next: FileSort = { field: fileSort.field, direction: fileSort.direction === 'asc' ? 'desc' : 'asc' }
    setFileSort(next)
    writeFileSort(next)
  }
  const handleUploadSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || [])
    if (!selectedFiles.length) return
    openUploadDialog({
      files: selectedFiles,
      preferredRootId: activeRootId,
      preferredPath: listQueryPath,
      insertPaths: true,
    })
    event.target.value = ''
  }
  const pickTarget = (relativeToRoot: string) => {
    if (!onPick) return
    const absolutePath = joinPath(activeSourceRootPath, relativeToRoot)
    onPick({
      rootId: activeRootId,
      rootPath: activeSourceRootPath,
      rootLabel: activeRoot?.label || '',
      relativePath: relativeToRoot,
      absolutePath,
    })
  }
  const handlePickCurrentFolder = () => pickTarget(joinRelativePath(activeRootBasePath, currentPath))
  const handlePickItem = (item: FileEntry) => pickTarget(joinRelativePath(activeRootBasePath, item.path))
  const embedded = mode === 'explorer'
  const shellClass =
    isMobile || isPicker
      ? 'flex h-full min-h-0 flex-col overflow-hidden'
      : `relative flex h-full ${embedded ? 'min-w-0 flex-1' : 'shrink-0'} flex-col bg-bg-1 overflow-hidden ${dock === 'left' ? 'border-r border-[var(--line)]' : 'border-l border-[var(--line)]'}`
  const shellStyle = isMobile || embedded || isPicker ? undefined : { width: previewWidth ?? filePanelWidth }
  const imagePreviewPath =
    preview?.path &&
    preview.type === 'file' &&
    isImagePath(preview.path) &&
    // svg 是文本不会被标 binary,也直接走图片预览(<img> 会播放 SMIL/CSS 动画)
    (preview.binary ||
      preview.reason === 'binary-file' ||
      preview.reason === 'large-file' ||
      preview.path.toLowerCase().endsWith('.svg'))
      ? api.files.imageUrl(
          fileHostId,
          activeRootId,
          resolveRootRelativePath(activeRootBasePath, preview.path),
          preview.modifiedAt,
        )
      : ''
  useEffect(() => {
    setImagePreviewUrl('')
    if (!imagePreviewPath) {
      return
    }
    let cancelled = false
    let objectUrl = ''
    void fetchApiBlob(imagePreviewPath)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setImagePreviewUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setImagePreviewUrl('')
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [imagePreviewPath])
  useEffect(() => {
    if (!mobileRenderKind) {
      setMobileFileContent(null)
      return
    }
    let cancelled = false
    setMobileFileContent(null)
    void api.files
      .content(fileHostId, activeRootId, resolveRootRelativePath(activeRootBasePath, selectedPath!))
      .then((data) => {
        if (cancelled || data.binary || data.truncated || data.reason) return
        setMobileFileContent(data.content)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeRootBasePath, activeRootId, fileHostId, mobileRenderKind, selectedPath])
  const previewBlock = preview ? (
    imagePreviewUrl ? (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 p-3 text-xs text-text-3">
          <div className="font-mono text-text-1">{preview.path}</div>
          <div className="mt-1">{formatSize(preview.size)}</div>
        </div>
        <div className="min-h-0 flex-1">
          <ZoomSurface resetKey={preview.path} image className="h-full overflow-hidden">
            <img
              src={imagePreviewUrl}
              alt={preview.path}
              className="max-h-full max-w-full rounded-apple border border-[var(--line)] bg-bg-1 object-contain select-none"
            />
          </ZoomSurface>
        </div>
      </div>
    ) : preview.binary || preview.reason ? (
      <div className="p-3 text-xs text-text-3">
        <div className="font-mono text-text-1">{preview.path}</div>
        <div className="mt-2">
          {preview.reason === 'large-file'
            ? t('file.previewSkippedLarge')
            : preview.reason === 'binary-file'
              ? t('file.previewSkippedBinary')
              : t('file.previewUnavailable')}
        </div>
        <div className="mt-1">{formatSize(preview.size)}</div>
      </div>
    ) : mobileRenderKind && !mobileSourceView && mobileFileContent !== null ? (
      mobileRenderKind === 'markdown' ? (
        <ZoomSurface resetKey={selectedPath} className="tmuxgo-scrollbar h-full overflow-auto px-3 py-3">
          <article
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(mobileFileContent) || `<p>${t('editor.nothingToPreview')}</p>`,
            }}
            className={MARKDOWN_PROSE_CLASS}
          />
        </ZoomSurface>
      ) : mobileRenderKind === 'csv' ? (
        <div className="flex h-full min-h-0 flex-col">
          <CsvTable content={mobileFileContent} emptyLabel={t('editor.nothingToPreview')} />
        </div>
      ) : (
        <iframe
          title={preview.path}
          srcDoc={mobileFileContent}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      )
    ) : (
      <div className="tmuxgo-scrollbar h-full overflow-auto p-2 font-mono text-meta leading-5">
        {preview.lines.map((line) => (
          <div key={line.number} className="grid grid-cols-[42px_minmax(0,1fr)] gap-2">
            <span className="select-none text-right text-text-3">{line.number}</span>
            <span className="whitespace-pre-wrap break-words text-text-2">{line.content || ' '}</span>
          </div>
        ))}
      </div>
    )
  ) : (
    <div className="tmuxgo-scrollbar-subtle h-full overflow-auto p-3 text-xs text-text-3">
      <div className="text-text-2">{t('file.favorites')}</div>
      {visibleFavoriteDirectories.length ? (
        <div className="mt-2 space-y-1">
          {visibleFavoriteDirectories.map((item) => (
            <Chip
              key={`${item.rootId}-${item.path}`}
              {...bindFavoriteDirectoryDrag(item)}
              onClick={() => openDirectoryShortcut(item)}
              className="w-full truncate justify-start px-3 py-1.5 text-left font-mono text-meta"
              style={{ direction: 'rtl' }}
            >
              {formatDirectoryShortcutLabel(
                item.path,
                rootLabelById[item.rootId] || item.name,
                rootPathById[item.rootId] || '',
              )}
            </Chip>
          ))}
        </div>
      ) : (
        <div className="mt-2">{t('file.favoritesHint')}</div>
      )}
    </div>
  )
  const renderDesktopTree = (nodes: FileTreeNode[], depth = 0): React.ReactNode[] =>
    nodes.flatMap((node) => {
      const item = node.item
      const expanded = item.type === 'directory' && openDirectories.has(item.path)
      const visual = getFileVisual(item.path, item.type, expanded)
      const favoritePath = { rootId: activeRootId, path: joinRelativePath(activeRootBasePath, item.path) }
      const cachedChildren = expanded
        ? readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path)
        : undefined
      const loadStatus = expanded
        ? readDirectoryStatusFromCache(directoryStatus, activeRootId, activeRootBasePath, item.path)
        : undefined
      // 多选集合优先；selectedPaths 为空时回退 selectedPath（跟随高亮等路径）
      const selected = selectedPaths.size ? selectedPaths.has(item.path) : selectedPath === item.path
      const focused = selectedPath === item.path
      const row = (
        <div
          key={`${item.path}::__row`}
          data-selected={selected ? 'true' : undefined}
          data-focused={focused ? 'true' : undefined}
          {...bindDirectoryDrop(item)}
          className={`tmuxgo-list-row tmuxgo-file-tree-node group flex min-h-[22px] w-full items-center ${selected ? 'tmuxgo-list-row--active tmuxgo-file-tree-node-selected' : 'tmuxgo-list-row--hover'} ${focused && selectedPaths.size > 1 ? 'outline outline-1 -outline-offset-1 outline-accent/60' : ''} ${dropTargetPath === item.path ? 'tmuxgo-list-row--active' : ''} ${fileClipboard?.move && fileClipboard.rootId === activeRootId && fileClipboard.itemPath === item.path ? 'opacity-50' : ''}`}
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          <button
            type="button"
            disabled={item.type !== 'directory'}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (item.type === 'directory') void handleDesktopDirectoryToggle(item)
            }}
            className={`flex h-[22px] w-[14px] shrink-0 items-center justify-center font-mono text-caption ${item.type === 'directory' ? 'text-text-3 hover:text-accent' : 'text-transparent'}`}
          >
            {item.type === 'directory' ? (expanded ? '▾' : '▸') : ''}
          </button>
          <div
            role="button"
            tabIndex={0}
            data-row-path={item.path}
            title={getItemTooltip(item)}
            {...bindFileDrag(item)}
            onClick={(e) => {
              e.preventDefault()
              if (applyRowSelectGesture(item, e)) return
              if (item.type === 'directory') void handleDesktopDirectoryToggle(item)
              else openItem(item)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                // 方向键走数据序而非 DOM 序：目录行同样参与，且不受虚拟滚动裁剪影响
                const order = flatVisibleItems.map((entry) => entry.path)
                const nextPath = order[order.indexOf(item.path) + (e.key === 'ArrowUp' ? -1 : 1)]
                if (!nextPath) return
                selectSinglePath(nextPath)
                setSelectedPreviewLine(1)
                e.currentTarget
                  .closest('.tmuxgo-file-tree')
                  ?.querySelector<HTMLElement>(`[data-row-path="${CSS.escape(nextPath)}"]`)
                  ?.focus()
                return
              }
              // VSCode 树导航：→ 展开未展开目录，← 收起已展开目录
              if (item.type === 'directory' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                const expanded = openDirectories.has(item.path)
                if ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded)) {
                  e.preventDefault()
                  void handleDesktopDirectoryToggle(item)
                }
                return
              }
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              if (item.type === 'directory') void handleDesktopDirectoryToggle(item)
              else openItem(item)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // VSCode：右键点在未选中项 → 先把 selection 切到该项再弹菜单
              if (!selectedPaths.has(item.path)) selectSinglePath(item.path)
              showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
            }}
            onDoubleClick={() =>
              item.type === 'directory' ? void handleDesktopDirectoryToggle(item) : insertItemPath(item)
            }
            className="flex min-w-0 flex-1 items-center gap-1.5 py-[2px] pr-2"
          >
            <span className="shrink-0">{visual.icon}</span>
            <span className={`min-w-0 flex-1 truncate font-mono ${visual.tone}`}>{item.name}</span>
            {item.type === 'directory' && cachedChildren?.length === 0 && (
              <span className="shrink-0 font-mono text-caption text-text-3">{t('file.emptyDir')}</span>
            )}
            {item.type === 'directory' && !cachedChildren && loadStatus?.state === 'loading' && (
              <span className="shrink-0 font-mono text-caption text-text-3">{t('file.loading')}</span>
            )}
            {item.type === 'directory' && !cachedChildren && loadStatus?.state === 'error' && (
              <div className="flex shrink-0 items-center gap-1">
                <span className="font-mono text-caption text-danger">{t('file.treeLoadFailed')}</span>
                <button
                  type="button"
                  title={loadStatus.message}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void loadDirectoryChildren(item)
                  }}
                  className="font-mono text-caption text-accent hover:text-text-1"
                >
                  {t('file.retryLoad')}
                </button>
              </div>
            )}
            {item.type === 'directory' ? (
              <FavoriteDirectoryButton
                active={isFavoriteDirectory(favoritePath)}
                name={item.name}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggleFavoriteDirectory(item)
                }}
              />
            ) : (
              <span className="opacity-0 text-caption text-text-3 group-hover:opacity-100 transition-opacity">
                {formatSize(item.size)}
              </span>
            )}
          </div>
        </div>
      )
      const nested =
        item.type === 'directory' && expanded && node.children?.length
          ? renderDesktopTree(node.children, depth + 1)
          : []
      return [row, ...nested]
    })
  const renderSearchList = (entries: FileEntry[], depth = 0): React.ReactNode[] =>
    entries
      .filter(
        (item) => (!hideDotFiles || !isDotPath(item.path || item.name)) && matchesFileTypeFilter(item, fileTypeFilter),
      )
      .flatMap((item) => {
        const cache =
          item.type === 'directory'
            ? readDirectoryChildrenFromCache(directoryCache, activeRootId, activeRootBasePath, item.path)
            : undefined
        const status =
          item.type === 'directory'
            ? readDirectoryStatusFromCache(directoryStatus, activeRootId, activeRootBasePath, item.path)
            : undefined
        const nested =
          item.type !== 'directory' || !openDirectories.has(item.path)
            ? []
            : cache
              ? cache.length
                ? renderSearchList(cache, depth + 1)
                : [
                    <div
                      key={`${item.path}::__empty`}
                      className="px-2 py-[3px] font-mono text-meta text-text-3"
                      style={!isMobile ? { paddingLeft: `${22 + (depth + 1) * 14}px` } : undefined}
                    >
                      {t('file.emptyDir')}
                    </div>,
                  ]
              : status?.state === 'error'
                ? [
                    <div
                      key={`${item.path}::__error`}
                      className="flex items-center gap-2 px-2 py-[3px] font-mono text-meta"
                      style={!isMobile ? { paddingLeft: `${22 + (depth + 1) * 14}px` } : undefined}
                    >
                      <span className="text-danger">{t('file.treeLoadFailed')}</span>
                      <button
                        type="button"
                        title={status.message}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void loadDirectoryChildren(item)
                        }}
                        className="text-accent hover:text-text-1"
                      >
                        {t('file.retryLoad')}
                      </button>
                    </div>,
                  ]
                : [
                    <div
                      key={`${item.path}::__loading`}
                      className="px-2 py-[3px] font-mono text-meta text-text-3"
                      style={!isMobile ? { paddingLeft: `${22 + (depth + 1) * 14}px` } : undefined}
                    >
                      {t('file.loading')}
                    </div>,
                  ]
        const visual = getFileVisual(item.path, item.type, openDirectories.has(item.path))
        const rowSelected = selectedPaths.size ? selectedPaths.has(item.path) : selectedPath === item.path
        return [
          <button
            key={`${item.type}-${item.path}`}
            tabIndex={0}
            title={getItemTooltip(item)}
            {...bindFileDrag(item)}
            {...bindDirectoryDrop(item)}
            onClick={(e) => {
              if (applyRowSelectGesture(item, e)) return
              openItem(item)
            }}
            onDoubleClick={() =>
              item.type === 'directory' ? void handleDesktopDirectoryToggle(item) : insertItemPath(item)
            }
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
              if (!selectedPaths.has(item.path)) selectSinglePath(item.path)
              showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
            }}
            onTouchStart={(e) => {
              if (!isMobile) return
              const touch = e.touches[0]
              if (!touch) return
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = setTimeout(
                () => showContextMenu(touch.clientX, touch.clientY, item, getParentRelativePath(item, currentPath)),
                520,
              )
            }}
            onTouchMove={() => {
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = null
            }}
            onTouchEnd={() => {
              if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
              touchTimerRef.current = null
            }}
            className={`tmuxgo-list-row group w-full border-l-2 px-2 py-[3px] text-left text-meta leading-4 ${rowSelected ? 'tmuxgo-list-row--active border-accent' : 'border-transparent tmuxgo-list-row--hover'} ${dropTargetPath === item.path ? 'tmuxgo-list-row--active' : ''}`}
            style={!isMobile && showSearchResults ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <span className="flex shrink-0 items-center gap-1">
                {item.type === 'directory' && (
                  <span className="w-2 text-accent">{openDirectories.has(item.path) ? '▾' : '▸'}</span>
                )}
                <span>{visual.icon}</span>
              </span>
              <span
                className={`min-w-0 flex-1 truncate font-mono ${item.type === 'directory' ? 'text-text-1' : visual.tone}`}
              >
                {item.name}
              </span>
              <span className="opacity-0 text-caption text-text-3 group-hover:opacity-100 transition-opacity">
                {item.type === 'file' ? formatSize(item.size) : 'dir'}
              </span>
            </div>
            {'matches' in item && item.matches?.[0] && (
              <div className="truncate pl-4 font-mono text-caption text-text-3">
                L{item.matches[0].number}: {item.matches[0].content}
              </div>
            )}
          </button>,
          ...nested,
        ]
      })
  const renderMobileList = (entries: FileEntry[]): React.ReactNode[] =>
    entries.map((item: any) =>
      item.type === 'directory' ? (
        <button
          key={`${item.type}-${item.path}`}
          tabIndex={0}
          title={getItemTooltip(item)}
          onClick={() => openItem(item)}
          onDoubleClick={() => (isPicker ? handlePickItem(item) : insertItemPath(item))}
          onKeyDown={(e) => selectFromKeyboard(item, e)}
          onContextMenu={(e) => {
            if (isPicker) return
            e.preventDefault()
            showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
          }}
          className={`tmuxgo-list-row group h-7 w-full border-l-2 px-2 py-1 text-left text-meta leading-5 ${selectedPath === item.path ? 'tmuxgo-list-row--active border-accent' : 'border-transparent tmuxgo-list-row--hover'}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-accent">▸</span>
            <span className="min-w-0 flex-1 truncate font-mono text-text-1">{item.name}</span>
          </div>
        </button>
      ) : (
        <button
          key={`${item.type}-${item.path}`}
          tabIndex={0}
          title={getItemTooltip(item)}
          onClick={() => openItem(item)}
          onDoubleClick={() => (isPicker ? undefined : insertItemPath(item))}
          onKeyDown={(e) => selectFromKeyboard(item, e)}
          onContextMenu={(e) => {
            if (isPicker) return
            e.preventDefault()
            showContextMenu(e.clientX, e.clientY, item, getParentRelativePath(item, currentPath))
          }}
          onTouchStart={(e) => {
            if (!isMobile || isPicker) return
            const touch = e.touches[0]
            if (!touch) return
            if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
            touchTimerRef.current = setTimeout(
              () => showContextMenu(touch.clientX, touch.clientY, item, getParentRelativePath(item, currentPath)),
              520,
            )
          }}
          onTouchMove={() => {
            if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
            touchTimerRef.current = null
          }}
          onTouchEnd={() => {
            if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
            touchTimerRef.current = null
          }}
          className={`tmuxgo-list-row group h-7 w-full border-l-2 px-2 py-[3px] text-left text-meta leading-4 ${selectedPath === item.path ? 'tmuxgo-list-row--active border-accent' : 'border-transparent tmuxgo-list-row--hover'}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="shrink-0">{getFileVisual(item.path, item.type, openDirectories.has(item.path)).icon}</span>
            <span
              className={`min-w-0 flex-1 truncate font-mono ${getFileVisual(item.path, item.type, openDirectories.has(item.path)).tone}`}
            >
              {item.name}
            </span>
            <span className="opacity-0 text-caption text-text-3 group-hover:opacity-100 transition-opacity">
              {item.type === 'file' ? formatSize(item.size) : 'dir'}
            </span>
          </div>
          {'matches' in item && item.matches?.[0] && (
            <div className="truncate pl-4 font-mono text-caption text-text-3">
              L{item.matches[0].number}: {item.matches[0].content}
            </div>
          )}
        </button>
      ),
    )
  const desktopTreeRows = renderDesktopTree(desktopTreeData)
  const desktopTreeSelectedIndex = getTreeRowIndex(desktopTreeData, selectedPath)
  const mobileRows = renderMobileList(visibleItems)
  // 右键项已选中 → 菜单作用于整个 selection；未选中 → 仅该项（onContextMenu 已先把它切成单选）
  const contextMenuSelection: FileEntry[] =
    contextMenu?.item && selectedPaths.has(contextMenu.item.path) && selectedItems.length > 1
      ? selectedItems
      : contextMenu?.item
        ? [contextMenu.item]
        : []

  return (
    <aside className={shellClass} style={shellStyle}>
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadSelect} />
      {!isMobile && !embedded && (
        <div
          className={`absolute top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 ${dock === 'left' ? 'right-0' : 'left-0'}`}
          onMouseDown={() => {
            resizingRef.current = true
            pendingWidthRef.current = filePanelWidth
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
            emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
          }}
        />
      )}
      {!contentReady ? (
        <div className="flex h-full items-center justify-center text-xs text-text-3">{t('file.loading')}</div>
      ) : (
        <>
          <div className="shrink-0 border-b border-[var(--line)] px-2 py-2">
            <div className="flex items-center gap-1.5">
              {isMobile && mobileView === 'preview' && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="back to list"
                  onClick={() => {
                    if (mobileEditOpen) closeMobileEditor()
                    else setMobileView('list')
                  }}
                >
                  ‹
                </Button>
              )}
              {(isMobile ? mobileView !== 'preview' : isPicker) && !!currentPath && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="go back"
                  onClick={() =>
                    mobileNavigationDepthRef.current > 0 ? window.history.back() : goMobileParentDirectory()
                  }
                >
                  ‹
                </Button>
              )}

              <Select
                value={selectedRootId}
                onChange={(v) => {
                  setFollowSuspended(true)
                  switchRoot(v)
                }}
                options={rootOptions.map((item) => ({ value: item.id, label: item.label }))}
                className="min-w-0 flex-1 rounded-apple px-2 py-1 text-meta"
              />
              {isPicker ? (
                <>
                  <Chip tone="accent" onClick={handlePickCurrentFolder}>
                    {t('session.selectThisFolder')}
                  </Chip>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="close"
                    onClick={onClose || (() => setFilePanelOpen(false))}
                  >
                    ×
                  </Button>
                </>
              ) : (
                <>
                  <button
                    title={t('file.upload')}
                    aria-label={t('file.upload')}
                    onClick={() => uploadInputRef.current?.click()}
                    className="tmuxgo-toolbar-icon h-7 w-7 shrink-0"
                  >
                    <FiUpload size={14} />
                  </button>
                  <button
                    title={t('file.trash')}
                    aria-label={t('file.trash')}
                    onClick={() => void openTrash()}
                    className="tmuxgo-toolbar-icon h-7 w-7 shrink-0"
                  >
                    <FiTrash2 size={14} />
                  </button>
                  {activeFavorite && (
                    <button
                      title={t('file.removeFavorite')}
                      aria-label={t('file.removeFavorite')}
                      onClick={() => removeFavoriteDirectory(activeFavorite)}
                      className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--active h-7 w-7 shrink-0"
                    >
                      <FiStar size={14} fill="currentColor" />
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="close"
                    onClick={() => {
                      if (mobileEditOpen && mobileEditDirty) {
                        pendingSheetCloseAfterDiscardRef.current = true
                        setMobileEditConfirm('exit')
                      } else (onClose || (() => setFilePanelOpen(false)))()
                    }}
                  >
                    ×
                  </Button>
                </>
              )}
            </div>
            {isPicker && (
              <div
                className="mt-1 truncate font-mono text-caption text-text-3"
                title={joinPath(activeSourceRootPath, joinRelativePath(activeRootBasePath, currentPath))}
              >
                {joinPath(activeSourceRootPath, joinRelativePath(activeRootBasePath, currentPath)) || '/'}
              </div>
            )}
          </div>
          {(!isMobile || mobileView === 'list') && (
            <div className="shrink-0 border-b border-[var(--line)] px-2 py-2">
              <div className="flex items-center gap-1">
                <div className="relative min-w-0 flex-1">
                  <FiSearch
                    size={13}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-3"
                  />
                  <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setSearchNavigationPath(null)
                    }}
                    onKeyDown={(e) => {
                      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
                      const modifier = isMac ? e.metaKey : e.ctrlKey
                      if (modifier && e.key === 'Delete') {
                        e.preventDefault()
                        setQuery('')
                        setDebouncedQuery('')
                        setSearchNavigationPath(null)
                      }
                    }}
                    placeholder={searchMode === 'name' ? t('file.searchName') : t('file.searchContent')}
                    className="tmuxgo-control tmuxgo-input w-full rounded-apple py-1 pl-7 pr-6 font-mono text-meta"
                  />
                  <button
                    onClick={() => {
                      setQuery('')
                      setDebouncedQuery('')
                      setSearchNavigationPath(null)
                    }}
                    disabled={!query}
                    aria-label={t('file.clearSearch')}
                    className={`tmuxgo-toolbar-icon absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 ${query ? '' : 'opacity-40'}`}
                  >
                    ×
                  </button>
                </div>
                <div className="tmuxgo-segment flex shrink-0">
                  {(['name', 'content'] as SearchMode[]).map((item) => (
                    <button
                      key={item}
                      title={item === 'name' ? t('file.searchName') : t('file.searchContent')}
                      aria-label={item === 'name' ? t('file.searchName') : t('file.searchContent')}
                      aria-pressed={searchMode === item}
                      onClick={() => {
                        setSearchMode(item)
                        setSearchNavigationPath(null)
                      }}
                      className="tmuxgo-segment__item !px-0 w-7"
                    >
                      {item === 'name' ? <FiFileText size={13} /> : <FiAlignLeft size={13} />}
                    </button>
                  ))}
                </div>
              </div>
              {!isPicker && (
                <div className="mt-1 flex items-center gap-1">
                  <div className="tmuxgo-segment">
                    {(['all', 'file', 'directory'] as FileTypeFilter[]).map((item) => (
                      <button
                        key={item}
                        title={item === 'all' ? t('file.all') : item === 'file' ? t('file.file') : t('file.dir')}
                        aria-label={item === 'all' ? t('file.all') : item === 'file' ? t('file.file') : t('file.dir')}
                        aria-pressed={fileTypeFilter === item}
                        onClick={() => setFileTypeFilter(item)}
                        className="tmuxgo-segment__item !px-0 w-7"
                      >
                        {item === 'all' ? (
                          <FiLayers size={13} />
                        ) : item === 'file' ? (
                          <FiFile size={13} />
                        ) : (
                          <FiFolder size={13} />
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1" />
                  <button
                    onClick={refreshFiles}
                    title={`${t('file.refresh')} (F5)`}
                    aria-label={t('file.refresh')}
                    className="tmuxgo-toolbar-icon h-7 w-7 shrink-0"
                  >
                    <FiRefreshCw size={14} />
                  </button>
                  <button
                    onClick={(e) => setSortMenu({ x: Math.min(e.clientX, window.innerWidth - 176), y: e.clientY + 6 })}
                    title={`${t('file.sort')}: ${fileSort.field === 'name' ? t('file.sortName') : fileSort.field === 'size' ? t('file.sortSize') : t('file.sortModified')} · ${fileSort.direction === 'asc' ? t('file.sortAsc') : t('file.sortDesc')}`}
                    aria-label={t('file.sort')}
                    aria-haspopup="menu"
                    className="tmuxgo-toolbar-icon h-7 w-7 shrink-0"
                  >
                    {fileSort.direction === 'asc' ? '↑' : '↓'}
                  </button>
                  <button
                    onClick={() => updateHideDotFiles(!hideDotFiles)}
                    title={t('file.dotfiles')}
                    aria-label={t('file.dotfiles')}
                    aria-pressed={!hideDotFiles}
                    className={`tmuxgo-toolbar-icon h-7 w-7 shrink-0 ${hideDotFiles ? '' : 'tmuxgo-toolbar-icon--active'}`}
                  >
                    {hideDotFiles ? <FiEyeOff size={14} /> : <FiEye size={14} />}
                  </button>
                  <button
                    onClick={clearExpandedDirectories}
                    disabled={!openDirectories.size && !directoryCache.size}
                    title={t('file.clearExpanded')}
                    aria-label={t('file.clearExpanded')}
                    className={`tmuxgo-toolbar-icon h-7 w-7 shrink-0 ${openDirectories.size || directoryCache.size ? '' : 'opacity-40'}`}
                  >
                    <FiChevronsUp size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
          {(!isMobile || mobileView === 'list') && (
            <div
              className="min-h-0 flex flex-1 flex-col overflow-hidden"
              onKeyDown={handleListKeyDown}
              onContextMenu={(e) => {
                if (isPicker) return
                if ((e.target as HTMLElement).closest('button')) return
                e.preventDefault()
                showContextMenu(e.clientX, e.clientY, null, currentPath)
              }}
              onDragOver={(e) => {
                // 列表空白区 drop = 移入 currentPath；目录行自身已 stopPropagation
                if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                const payload = readDraggedFile(e.dataTransfer)
                if (!payload || isPicker) return
                e.preventDefault()
                setDropTargetPath(null)
                void dropMoveItems(payload, currentPath)
              }}
            >
              {!showSearchResults && visibleFavoriteDirectories.length > 0 && (
                <div className="border-b border-[var(--line)] p-3 trae-browser-inspect-draggable">
                  <div className="mb-2 text-caption uppercase tracking-[0.18em] text-text-3">
                    {t('file.favoriteDirs')}
                  </div>
                  <div className="tmuxgo-scrollbar-subtle max-h-36 space-y-1 overflow-y-auto overscroll-contain">
                    {visibleFavoriteDirectories.map((item) => {
                      const favorited = isFavoriteDirectory(item)
                      return (
                        <div
                          key={`${item.rootId}-${item.path}`}
                          {...bindFavoriteDirectoryDrag(item)}
                          title={item.path}
                          className={`tmuxgo-list-row tmuxgo-list-row--hover flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-meta text-text-2 ${favorited ? '' : 'opacity-60'}`}
                        >
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleFavoriteAreaEntry(item)
                            }}
                            aria-label={`${favorited ? t('file.removeFavorite') : t('file.addFavorite')} ${item.name}`}
                            title={favorited ? t('file.removeFavorite') : t('file.addFavorite')}
                            className="shrink-0 rounded-apple hover:text-text-1"
                          >
                            <FiStar
                              size={11}
                              fill={favorited ? 'currentColor' : 'none'}
                              className={favorited ? 'text-accent' : 'text-text-3'}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => openDirectoryShortcut(item)}
                            className="min-w-0 flex-1 truncate text-left font-mono hover:text-text-1"
                            style={{ direction: 'rtl' }}
                          >
                            {formatDirectoryShortcutLabel(
                              item.path,
                              rootLabelById[item.rootId] || item.name,
                              rootPathById[item.rootId] || '',
                            )}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {!showSearchResults && parentDirectory && (
                <div className="shrink-0 border-b border-[var(--line)] px-3 py-1.5">
                  <button
                    type="button"
                    onClick={goParentDirectory}
                    title={`${t('file.upToParent')}\n${parentDirectory.label || '/'}`}
                    aria-label={t('file.upToParent')}
                    className="tmuxgo-list-row tmuxgo-list-row--hover flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-meta text-text-2 hover:text-text-1"
                  >
                    <FiArrowUp size={11} className="shrink-0 text-text-3" aria-hidden="true" />
                    <span className="shrink-0 font-mono text-text-1">..</span>
                    <span
                      className="min-w-0 flex-1 truncate text-right font-mono text-caption text-text-3"
                      style={{ direction: 'rtl' }}
                    >
                      {parentDirectory.label || '/'}
                    </span>
                  </button>
                </div>
              )}
              {(listLoading || searchLoading) && <div className="p-3 text-xs text-text-3">{t('file.loading')}</div>}
              {!isMobile && !isPicker && !showSearchResults && !listLoading && (
                <VirtualizedRows
                  rows={desktopTreeRows}
                  rowHeight={24}
                  className="tmuxgo-file-tree tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
                  resetKey={`${selectedRootId}:${currentPath}`}
                  ensureVisibleIndex={desktopTreeSelectedIndex}
                />
              )}
              {!listLoading && showSearchResults && (
                <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
                  {renderSearchList(visibleItems)}
                </div>
              )}
              {!listLoading && !showSearchResults && (isMobile || isPicker) && (
                <VirtualizedRows
                  rows={mobileRows}
                  rowHeight={28}
                  className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
                  resetKey={`${selectedRootId}:${currentPath}`}
                />
              )}
              {!listLoading && !searchLoading && !visibleItems.length && (
                <div className="p-3 text-xs text-text-3">
                  {showSearchResults ? t('file.noResults') : t('file.emptyDir')}
                </div>
              )}
              {showSearchResults && rawSearchResults.length > SEARCH_RESULT_LIMIT && (
                <div className="border-t border-[var(--line)] px-3 py-2 text-meta text-text-3">
                  {t('file.tooManyResults', { count: SEARCH_RESULT_LIMIT })}
                </div>
              )}
            </div>
          )}
          {isMobile && mobileView === 'preview' && (
            <div className="min-h-0 flex-1 bg-bg-0">
              {mobileEditOpen ? (
                mobileEditLoading ? (
                  <div className="flex h-full items-center justify-center p-3 text-xs text-text-3">
                    {t('file.loading')}
                  </div>
                ) : (
                  <textarea
                    value={mobileEditContent}
                    onChange={(event) => setMobileEditContent(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label={t('file.mobileEdit')}
                    className="tmuxgo-scrollbar h-full w-full resize-none whitespace-pre overflow-auto bg-bg-0 p-2 font-mono text-meta leading-5 text-text-1 outline-none"
                  />
                )
              ) : (
                previewBlock
              )}
            </div>
          )}
          {isMobile &&
            mobileView === 'preview' &&
            selectedPath &&
            (mobileEditOpen ? (
              <div className="flex gap-2 border-t border-[var(--line)] p-3">
                <button
                  disabled={mobileEditLoading || mobileEditSaving || !mobileEditDirty}
                  onClick={() => void saveMobileEditor()}
                  className="min-w-0 flex-1 rounded-apple bg-accent/10 px-3 py-3 text-sm text-accent active:scale-[0.98] disabled:opacity-40"
                >
                  {mobileEditSaving ? t('editor.saving') : t('editor.save')}
                </button>
                <button
                  disabled={mobileEditLoading || mobileEditSaving}
                  onClick={closeMobileEditor}
                  className="rounded-apple bg-bg-2 px-3 py-3 text-sm text-text-1 active:scale-[0.98]"
                >
                  {t('file.mobileEditExit')}
                </button>
              </div>
            ) : (
              <div className="flex gap-2 border-t border-[var(--line)] p-3">
                <button
                  onClick={() =>
                    insertPath(
                      activeSourceRootPath
                        ? joinPath(activeSourceRootPath, resolveRootRelativePath(activeRootBasePath, selectedPath))
                        : resolveRootRelativePath(activeRootBasePath, selectedPath),
                    )
                  }
                  className="min-w-0 flex-1 rounded-apple bg-accent/10 px-3 py-3 text-sm text-accent active:scale-[0.98]"
                >
                  {t('file.insertPath')}
                </button>
                {mobileRenderKind && (
                  <button
                    onClick={() => setMobileSourceView((value) => !value)}
                    className="rounded-apple bg-bg-2 px-3 py-3 text-sm text-text-1 active:scale-[0.98]"
                  >
                    {mobileSourceView ? t('file.mobileViewRendered') : t('file.mobileViewSource')}
                  </button>
                )}
                {mobileEditable && (
                  <button
                    onClick={openMobileEditor}
                    className="rounded-apple bg-bg-2 px-3 py-3 text-sm text-text-1 active:scale-[0.98]"
                  >
                    {t('file.mobileEdit')}
                  </button>
                )}
              </div>
            ))}
          {!isPicker && (!isMobile || mobileView === 'list') && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--line)] px-3 py-1.5">
              <span className="min-w-0 truncate text-meta text-text-3" title={t('file.followActivePathHint')}>
                {t('file.followActivePath')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={followActivePath}
                aria-label={t('file.followActivePath')}
                onClick={() => {
                  const next = !followActivePath
                  writeFollowActivePath(next)
                  setFollowActivePath(next)
                  setFollowSuspended(false)
                  if (next) lastFollowedEditorKeyRef.current = ''
                }}
                className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${followActivePath ? 'bg-accent' : 'bg-bg-2'}`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${followActivePath ? 'right-0.5' : 'left-0.5'}`}
                />
              </button>
            </div>
          )}
          {contextMenu && (
            <>
              <div className="fixed inset-0 z-[89]" onClick={() => setContextMenu(null)} />
              <div
                className="tmuxgo-menu fixed z-[90] w-44 py-1 text-xs"
                style={
                  contextMenu.mobile
                    ? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
                    : { left: contextMenu.x, top: contextMenu.y }
                }
                onClick={(e) => e.stopPropagation()}
              >
                {contextMenu.item?.type === 'directory' &&
                  (() => {
                    const favoriteKey = {
                      rootId: activeRoot?.sourceRootId || '',
                      path: joinRelativePath(activeRootBasePath, contextMenu.item!.path),
                    }
                    const isFav = isFavoriteDirectory(favoriteKey)
                    return (
                      <button
                        onClick={() => {
                          toggleFavoriteDirectory(contextMenu.item as FileItem)
                          setContextMenu(null)
                        }}
                        className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                      >
                        {isFav ? t('file.removeFavorite') : t('file.addFavorite')}
                      </button>
                    )
                  })()}
                {contextMenu.item?.type === 'file' && (
                  <button
                    onClick={() => {
                      openInEditor(contextMenu.item!)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.openEditor')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      insertItemPath(contextMenu.item!)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.insertPathCtx')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => void copyItemName(contextMenu.item!).finally(() => setContextMenu(null))}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.copyName')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => void copyItemRelativePath(contextMenu.item!).finally(() => setContextMenu(null))}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.copyRelativePath')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => void copyItemPath(contextMenu.item!).finally(() => setContextMenu(null))}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.copyPath')}
                  </button>
                )}
                {isMobile && contextMenu.item?.type === 'file' && (
                  <button
                    onClick={() => {
                      selectSinglePath(contextMenu.item!.path)
                      setSelectedPreviewLine(getPreviewLine(contextMenu.item!))
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.openPreview')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      // 右键点在已选中项上 → 菜单作用于整个 selection
                      for (const entry of contextMenuSelection) startDownload(entry)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {contextMenuSelection.length > 1
                      ? t('file.downloadMany', { count: contextMenuSelection.length })
                      : t('file.download')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      void transferItems(contextMenuSelection, false)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {contextMenuSelection.length > 1
                      ? t('file.copyMany', { count: contextMenuSelection.length })
                      : t('file.copy')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      void transferItems(contextMenuSelection, true)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {contextMenuSelection.length > 1
                      ? t('file.moveMany', { count: contextMenuSelection.length })
                      : t('file.move')}
                  </button>
                )}
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      void renameItem(contextMenu.item!)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    {t('file.rename')}
                  </button>
                )}
                <button
                  onClick={() => {
                    void createEntry('file', contextMenu.directoryPath)
                    setContextMenu(null)
                  }}
                  className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                >
                  {t('file.newFile')}
                </button>
                <button
                  onClick={() => {
                    void createEntry('directory', contextMenu.directoryPath)
                    setContextMenu(null)
                  }}
                  className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                >
                  {t('file.newFolder')}
                </button>
                {contextMenu.item && (
                  <button
                    onClick={() => {
                      setPendingDeleteItems(contextMenuSelection)
                      setContextMenu(null)
                    }}
                    className="tmuxgo-menu-item tmuxgo-menu-item--danger py-2 text-xs"
                  >
                    {contextMenuSelection.length > 1
                      ? t('file.moveToTrashMany', { count: contextMenuSelection.length })
                      : t('file.moveToTrash')}
                  </button>
                )}
              </div>
            </>
          )}
          {sortMenu && (
            <>
              <div className="fixed inset-0 z-[89]" onClick={() => setSortMenu(null)} />
              {/* 排序菜单复用 contextMenu 的 fixed 定位模式；宽 10rem 故打开时 x 已按 176px 收边 */}
              <div
                className="tmuxgo-menu fixed z-[90] w-40 py-1 text-xs"
                style={{ left: sortMenu.x, top: sortMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                {(['name', 'size', 'modified'] as SortField[]).map((field) => (
                  <button
                    key={field}
                    onClick={() => {
                      updateFileSort(field)
                      setSortMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    <span className="w-4 shrink-0 text-accent">{fileSort.field === field ? '✓' : ''}</span>
                    {field === 'name'
                      ? t('file.sortName')
                      : field === 'size'
                        ? t('file.sortSize')
                        : t('file.sortModified')}
                  </button>
                ))}
                <div className="mx-2 my-1 border-t border-[var(--line)]" />
                {(['asc', 'desc'] as SortDirection[]).map((direction) => (
                  <button
                    key={direction}
                    onClick={() => {
                      if (fileSort.direction !== direction) toggleSortDirection()
                      setSortMenu(null)
                    }}
                    className="tmuxgo-menu-item py-2 text-xs hover:text-accent"
                  >
                    <span className="w-4 shrink-0 text-accent">{fileSort.direction === direction ? '✓' : ''}</span>
                    {direction === 'asc' ? t('file.sortAsc') : t('file.sortDesc')}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {PromptElement}
      <ConfirmDialog
        open={pendingDeleteItems.length > 0}
        title={t('file.delete')}
        message={
          pendingDeleteItems.length > 1
            ? t('file.deleteConfirmMany', { count: pendingDeleteItems.length })
            : t('file.deleteConfirm', {
                type:
                  pendingDeleteItems[0]?.type === 'directory'
                    ? t('file.newFolder').toLowerCase()
                    : t('file.file').toLowerCase(),
                path: pendingDeleteItems[0]
                  ? resolveRootRelativePath(activeRootBasePath, pendingDeleteItems[0].path)
                  : '',
              })
        }
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteItems([])}
        onConfirm={() => void confirmRemoveItem()}
      />
      <ConfirmDialog
        open={mobileEditConfirm === 'enter'}
        title={t('file.mobileEditConfirmTitle')}
        message={t('file.mobileEditConfirmMessage')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setMobileEditConfirm(null)}
        onConfirm={() => void enterMobileEditor()}
      />
      <ConfirmDialog
        open={mobileEditConfirm === 'exit'}
        title={t('file.mobileEditExitTitle')}
        message={t('file.mobileEditExitMessage')}
        confirmLabel={t('file.mobileEditDiscard')}
        cancelLabel={t('file.mobileEditKeepEditing')}
        tone="danger"
        onCancel={() => setMobileEditConfirm(null)}
        onConfirm={discardMobileEditor}
      />
      {lastTrashedItem && (
        <div className="tmuxgo-float-surface absolute bottom-3 left-3 right-3 z-30 flex items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-text-2">
            {t('file.movedToTrash', { name: lastTrashedItem.name })}
          </span>
          <Chip tone="accent" onClick={() => void restoreTrash(lastTrashedItem)}>
            {t('file.undo')}
          </Chip>
          <Button variant="ghost" size="icon-sm" aria-label="close" onClick={() => setLastTrashedItem(null)}>
            ×
          </Button>
        </div>
      )}
      {trashOpen && (
        <ModalPortal>
          <div
            className="fixed inset-0 z-[95] flex items-center justify-center tmuxgo-scrim-strong p-4"
            onClick={() => setTrashOpen(false)}
          >
            <div
              className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-lg overflow-hidden rounded-apple border"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--line)] p-4">
                <div className="text-base font-medium text-text-1">{t('file.trash')}</div>
                <Button variant="ghost" size="icon-sm" aria-label="close" onClick={() => setTrashOpen(false)}>
                  ×
                </Button>
              </div>
              <div className="tmuxgo-scrollbar max-h-[55vh] overflow-auto">
                {!trashEntries.length && (
                  <div className="p-6 text-center text-sm text-text-3">{t('file.trashEmpty')}</div>
                )}
                {trashEntries.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text-1">{entry.name}</div>
                      <div className="truncate font-mono text-caption text-text-3">
                        {entry.path} · {new Date(entry.deletedAt).toLocaleString()}
                      </div>
                    </div>
                    <Chip tone="accent" onClick={() => void restoreTrash(entry)}>
                      {t('file.restore')}
                    </Chip>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </aside>
  )
}
