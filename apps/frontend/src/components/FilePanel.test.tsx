import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePanel } from './FilePanel'
import { api } from '@/lib/api'
import type { FileEditorDocument, FileItem, FileListResponse } from '@/types'

const clipboardMocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false })),
}))
const setFilePanelWidth = vi.fn()
const setFilePanelOpen = vi.fn()
const openUploadDialog = vi.fn()
const pushToast = vi.fn()
const invalidateQueries = vi.fn()
const delayedSrcResolvers: Array<() => void> = []
const preferencesGet = vi.fn(async () => ({ version: 1, updatedAt: '', customShortcuts: [], customShortcutsUpdatedAt: '', favoriteDirectories: [], favoriteDirectoriesUpdatedAt: '', sessionOrders: [], sessionOrdersUpdatedAt: '', uploadRateLimitKBps: 5120, downloadRateLimitKBps: 5120 }))
const preferencesUpdate = vi.fn(async (payload: any) => ({ version: 1, updatedAt: '', customShortcuts: [], customShortcutsUpdatedAt: '', favoriteDirectories: payload.favoriteDirectories || [], favoriteDirectoriesUpdatedAt: payload.favoriteDirectoriesUpdatedAt || '', sessionOrders: [], sessionOrdersUpdatedAt: '', uploadRateLimitKBps: payload.uploadRateLimitKBps || 5120, downloadRateLimitKBps: payload.downloadRateLimitKBps || 5120 }))
const consoleStoreState: { activeHostId: string; activeSessionId: string; filePanelWidth: number; setFilePanelWidth: typeof setFilePanelWidth; setFilePanelOpen: typeof setFilePanelOpen; openUploadDialog: typeof openUploadDialog; pushToast: typeof pushToast; openEditors: FileEditorDocument[]; activeEditorId: string | null } = { activeHostId: 'local', activeSessionId: 'session-a', filePanelWidth: 360, setFilePanelWidth, setFilePanelOpen, openUploadDialog, pushToast, openEditors: [], activeEditorId: null }

const roots = [
  { id: 'root-workspace', label: 'Workspace', path: '/workspace' },
  { id: 'root-home', label: 'Home', path: '/home/guo' },
]
let largeDirectoryItems: FileItem[] | null = null
const getListData = (rootId: string, currentPath: string): FileListResponse => {
  if (rootId === 'root-large' && largeDirectoryItems) return { root: roots.find((item) => item.id === rootId) || roots[0], path: currentPath, breadcrumbs: [{ name: '/', path: '' }], items: largeDirectoryItems }
  if (rootId === 'root-home' || rootId === 'root-workspace') {
    const root = roots.find((item) => item.id === rootId) || roots[0]
    if (!currentPath) return { root, path: '', breadcrumbs: [{ name: '/', path: '' }], items: [{ name: 'src', path: 'src', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'downloads', path: 'downloads', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: '.env', path: '.env', type: 'file', size: 4, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'src') return { root, path: 'src', breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }], items: [{ name: 'nested', path: 'src/nested', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 12, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'src/nested') return { root, path: 'src/nested', breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }, { name: 'nested', path: 'src/nested' }], items: [{ name: 'deep.ts', path: 'src/nested/deep.ts', type: 'file', size: 7, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'docs') return { root, path: 'docs', breadcrumbs: [{ name: '/', path: '' }, { name: 'docs', path: 'docs' }], items: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'project') return { root, path: 'project', breadcrumbs: [{ name: '/', path: '' }, { name: 'project', path: 'project' }], items: [{ name: 'demo.txt', path: 'project/demo.txt', type: 'file', size: 8, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'downloads') return { root, path: 'downloads', breadcrumbs: [{ name: '/', path: '' }, { name: 'downloads', path: 'downloads' }], items: [{ name: 'archive.zip', path: 'downloads/archive.zip', type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'photo.png', path: 'downloads/photo.png', type: 'file', size: 48, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
  }
  return { root: roots.find((item) => item.id === rootId) || roots[0], path: currentPath, breadcrumbs: [{ name: '/', path: '' }], items: [] }
}

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector?: any) => {
    return typeof selector === 'function' ? selector(consoleStoreState) : consoleStoreState
  }) as any,
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isFetching: false }),
  useQueryClient: () => ({ invalidateQueries }),
}))
vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: roots }),
  useFileList: (_hostId: string, nextRootId: string, nextCurrentPath: string, enabled = true) => {
    if (!enabled) return { data: undefined, isLoading: false }
    return { data: getListData(nextRootId || 'root-workspace', nextCurrentPath), isLoading: false }
  },
  useFilePreview: (_hostId: string, _rootId: string, path: string, line = 1) => ({ data: path ? path.endsWith('.png') ? { path, type: 'file', size: 48, modifiedAt: '2026-05-26T00:00:00.000Z', binary: true, truncated: false, reason: 'binary-file', lines: [] } : { path, type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z', binary: false, truncated: false, lines: [{ number: line, content: `line-${line}` }] } : null }),
  useFileSearch: (_hostId: string, _rootId: string, mode: string, query: string, basePath = '', includeDotFiles = true) => {
    if (mode === 'content' && query === 'needle') return { data: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z', matches: [{ number: 42, content: 'needle here' }] }], isFetching: false }
    if (mode === 'content' && query === 'tmuxgo') return { data: includeDotFiles ? [{ name: '.history', path: '.history', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z', matches: [{ number: 7, content: 'tmuxgo hidden' }] }] : [{ name: 'README.md', path: 'README.md', type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z', matches: [{ number: 3, content: 'TmuxGo visible' }] }], isFetching: false }
    if (mode === 'content' && query === 'slow') return { data: [], isFetching: true }
    if (query === 'docs' && !basePath) return { data: [{ name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    if (query === 'project' && !basePath) return { data: [{ name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    return { data: [], isFetching: false }
  },
}))
vi.mock('@/lib/clipboard-text', () => ({
  writeClipboardText: clipboardMocks.writeClipboardText,
}))
vi.mock('@/lib/api', () => ({
  fetchApiBlob: vi.fn(async () => new Blob(['image'])),
  api: {
    files: {
      list: vi.fn(async (_hostId: string, rootId: string, path = '') => getListData(rootId, path)),
      createFile: vi.fn(async () => ({ ok: true })),
      createDirectory: vi.fn(async () => ({ ok: true })),
      rename: vi.fn(async () => ({ ok: true, item: { path: 'renamed.txt' } })),
      copy: vi.fn(async () => ({ ok: true })),
      move: vi.fn(async () => ({ ok: true })),
      trash: vi.fn(async () => ({ ok: true, entry: { id: 'trash-1', rootId: 'root-workspace', path: 'demo.txt', name: 'demo.txt', type: 'file', deletedAt: '2026-05-26T00:00:00.000Z' } })),
      trashEntries: vi.fn(async () => ({ entries: [] })),
      restore: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      content: vi.fn(async () => ({ path: 'src/index.ts', type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z', binary: false, truncated: false, encoding: 'utf-8', content: 'hello\nworld' })),
      saveContent: vi.fn(async (_hostId: string, _rootId: string, _path: string, content: string) => ({ ok: true, content, modifiedAt: '2026-05-26T00:00:00.000Z', size: content.length })),
      downloadTask: vi.fn(),
      downloadUrl: vi.fn(() => '/api/files/download'),
      imageUrl: vi.fn(() => '/api/files/image'),
    },
    preferences: {
      get: () => preferencesGet(),
      update: (payload?: any) => preferencesUpdate(payload),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => {
    if (key === 'file.searchName') return 'Search file names'
    if (key === 'file.searchContent') return 'Search file content'
    if (key === 'file.all') return 'All'
    if (key === 'file.file') return 'File'
    if (key === 'file.dir') return 'Dir'
    if (key === 'file.dotfiles') return 'Dotfiles'
    if (key === 'file.loading') return 'Loading...'
    if (key === 'file.treeLoadFailed') return 'Load failed'
    if (key === 'file.retryLoad') return 'Retry'
    if (key === 'file.removeFavorite') return 'Unfavorite'
    if (key === 'file.clearExpanded') return 'Collapse all'
    if (key === 'file.clearSearch') return 'Clear search'
    if (key === 'file.copyPath') return 'Copy path'
    if (key === 'file.openPreview') return 'Open preview'
    if (key === 'file.openEditor') return 'Open in editor'
    if (key === 'file.mobileEdit') return 'Edit'
    if (key === 'file.mobileEditExit') return 'Exit editing'
    if (key === 'file.mobileEditConfirmTitle') return 'Enter edit mode?'
    if (key === 'file.mobileEditConfirmMessage') return 'Taps or scrolling may modify the file.'
    if (key === 'file.mobileEditExitTitle') return 'Unsaved changes'
    if (key === 'file.mobileEditExitMessage') return 'Exiting now will discard unsaved changes.'
    if (key === 'file.mobileEditDiscard') return 'Discard and exit'
    if (key === 'file.mobileEditKeepEditing') return 'Keep editing'
    if (key === 'editor.save') return 'Save'
    if (key === 'editor.saving') return 'Saving...'
    if (key === 'editor.saved') return 'Saved'
    if (key === 'common.confirm') return 'Confirm'
    if (key === 'common.cancel') return 'Cancel'
    return key
  } }),
}))

describe('FilePanel', () => {
  beforeEach(() => {
    localStorage.clear()
    setFilePanelWidth.mockReset()
    setFilePanelOpen.mockReset()
    openUploadDialog.mockReset()
    pushToast.mockReset()
    clipboardMocks.writeClipboardText.mockClear()
    preferencesGet.mockClear()
    preferencesUpdate.mockClear()
    vi.mocked(api.files.content).mockClear()
    vi.mocked(api.files.saveContent).mockClear()
    delayedSrcResolvers.length = 0
    consoleStoreState.activeHostId = 'local'
    consoleStoreState.activeSessionId = 'session-a'
    consoleStoreState.filePanelWidth = 360
    consoleStoreState.openEditors = []
    consoleStoreState.activeEditorId = null
    largeDirectoryItems = null
    roots.splice(2)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return window.setTimeout(() => cb(0), 0)
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows workspace as the default quick access root', async () => {
    render(React.createElement(FilePanel))
    expect(await screen.findByRole('option', { name: 'Workspace' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Home' })).toBeInTheDocument()
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('root-workspace')
  })
  it('commits panel width after resizing completes', async () => {
    const { container } = render(React.createElement(FilePanel))
    const handle = container.querySelector('.cursor-col-resize')
    const panel = container.querySelector('aside')
    expect(handle).not.toBeNull()
    expect(panel).not.toBeNull()
    fireEvent.mouseDown(handle!)
    fireEvent.mouseMove(window, { clientX: window.innerWidth - 300 })
    expect(setFilePanelWidth).not.toHaveBeenCalled()
    await waitFor(() => expect(panel).toHaveStyle({ width: '300px' }))
    fireEvent.mouseUp(window)
    expect(setFilePanelWidth).toHaveBeenCalledTimes(1)
    expect(setFilePanelWidth).toHaveBeenCalledWith(300)
  })

  it('expands and collapses directories on desktop', async () => {
    render(React.createElement(FilePanel))
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument())
  })

  it('adds and removes favorite directories on desktop', async () => {
    render(React.createElement(FilePanel))
    fireEvent.click(screen.getByRole('button', { name: 'Favorite src' }))
    let favorites = JSON.parse(localStorage.getItem('tmuxgo-favorite-directories') || '[]')
    expect(favorites.map((item: any) => `${item.rootId}:${item.path}`)).toEqual(['root-workspace:src'])
    fireEvent.click(screen.getByRole('button', { name: 'Unfavorite src' }))
    favorites = JSON.parse(localStorage.getItem('tmuxgo-favorite-directories') || '[]')
    expect(favorites).toEqual([])
  })

  it('opens a favorite directory shortcut on mobile', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    const favoriteButtons = await screen.findAllByRole('button', { name: '/home/guo/project' })
    fireEvent.click(favoriteButtons[0])
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
  })

  it('shows favorite directories as selectable roots', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    expect(await screen.findByRole('option', { name: 'project' })).toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
  })
  it('opens file from favorite root with full relative path', async () => {
    const onOpenFile = vi.fn()
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel, { onOpenFile }))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    fireEvent.click(await screen.findByText('demo.txt'))
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile.mock.calls[0][0]).toMatchObject({
      hostId: 'local',
      rootId: 'root-home',
      path: 'project/demo.txt',
      absolutePath: '/home/guo/project/demo.txt',
    })
  })
  it('opens images in editor area instead of file panel preview', async () => {
    const onOpenFile = vi.fn()
    render(React.createElement(FilePanel, { onOpenFile }))
    fireEvent.click(await screen.findByText('downloads'))
    fireEvent.click(await screen.findByText('photo.png'))
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenFile.mock.calls[0][0]).toMatchObject({
      hostId: 'local',
      rootId: 'root-workspace',
      path: 'downloads/photo.png',
      absolutePath: '/workspace/downloads/photo.png',
    })
  })
  it('copies file path from favorite root with full absolute path', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    fireEvent.contextMenu(await screen.findByText('demo.txt'))
    fireEvent.click(await screen.findByText('Copy path'))
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('/home/guo/project/demo.txt')
  })
  it('hides desktop preview action in explorer context menu', async () => {
    render(React.createElement(FilePanel, { onOpenFile: vi.fn() }))
    fireEvent.click(await screen.findByText('src'))
    const file = await screen.findByTitle(/^\/workspace\/src\/index\.ts /)
    fireEvent.contextMenu(file)
    expect(screen.getByText('Open in editor')).toBeInTheDocument()
    expect(screen.queryByText('Open preview')).not.toBeInTheDocument()
  })
  it('removes selected favorite root from header without affecting home', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    const removeBtn = await screen.findByRole('button', { name: 'Unfavorite' })
    fireEvent.click(removeBtn)
    await waitFor(() => expect(screen.queryByRole('option', { name: 'project' })).not.toBeInTheDocument())
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('root-home')
    const favorites = JSON.parse(localStorage.getItem('tmuxgo-favorite-directories') || '[]')
    expect(favorites).toEqual([])
  })
  it('follows the active editor and expands nested directories in explorer', async () => {
    consoleStoreState.openEditors = [{
      id: 'local:root-home:src/nested/deep.ts',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/guo',
      path: 'src/nested/deep.ts',
      name: 'deep.ts',
      absolutePath: '/home/guo/src/nested/deep.ts',
      language: 'typescript',
      content: '',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
      type: 'file',
    }]
    consoleStoreState.activeEditorId = 'local:root-home:src/nested/deep.ts'
    render(React.createElement(FilePanel))
    await waitFor(() => expect(screen.getByText('deep.ts')).toBeInTheDocument())
    expect(screen.getByText('nested')).toBeInTheDocument()
    expect(document.querySelector('.tmuxgo-file-tree [data-selected="true"]')?.textContent).toContain('deep.ts')
  })
  it('switches to the matching favorite root for the active editor', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'docs', path: 'docs' }, { rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    const view = render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'docs' })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:docs' } })
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    consoleStoreState.openEditors = [{
      id: 'local:root-home:project/demo.txt',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/guo',
      path: 'project/demo.txt',
      name: 'demo.txt',
      absolutePath: '/home/guo/project/demo.txt',
      language: 'plaintext',
      content: '',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
      type: 'file',
    }]
    consoleStoreState.activeEditorId = 'local:root-home:project/demo.txt'
    view.rerender(React.createElement(FilePanel))
    await waitFor(() => expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('favorite:root-home:project'))
    expect(screen.getByText('demo.txt')).toBeInTheDocument()
    expect(document.querySelector('.tmuxgo-file-tree [data-selected="true"]')?.textContent).toContain('demo.txt')
  })

  it('expands a searched directory in place on desktop while keeping name search active', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByText('docs'))
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    expect(input.value).toBe('docs')
    expect(screen.getByText('docs')).toBeInTheDocument()
  })
  it('shows directory children in desktop search results after expanding folder hit', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'src' } })
    const directory = await screen.findByText('src')
    expect(screen.queryByText('nested')).not.toBeInTheDocument()
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    fireEvent.click(directory)
    await waitFor(() => expect(screen.getByText('nested')).toBeInTheDocument())
    expect(screen.getByText('index.ts')).toBeInTheDocument()
    expect(input.value).toBe('src')
  })
  it('shows full path on hover for filtered directories and files', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'src' } })
    const directory = await screen.findByTitle(/^\/workspace\/src /)
    expect(directory).toHaveTextContent('src')
    fireEvent.click(directory)
    expect(await screen.findByTitle(/^\/workspace\/src\/index\.ts /)).toHaveTextContent('index.ts')
  })

  it('enters a searched directory on mobile while keeping name search active', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    expect(input.value).toBe('docs')
    const back = { handled: false }
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: back }))
    expect(back.handled).toBe(true)
    expect(await screen.findByText('docs')).toBeInTheDocument()
  })
  it('keeps search query after switching root', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(input, { target: { value: 'project' } })
    expect(input.value).toBe('project')
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('project')).toBeInTheDocument())
    expect(input.value).toBe('project')
  })
  it('falls back to source root when session changes from a favorite root', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    consoleStoreState.openEditors = [{
      id: 'local:root-home:project/demo.txt',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/guo',
      path: 'project/demo.txt',
      name: 'demo.txt',
      absolutePath: '/home/guo/project/demo.txt',
      language: 'plaintext',
      content: '',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
      type: 'file',
    }]
    consoleStoreState.activeEditorId = 'local:root-home:project/demo.txt'
    const view = render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
    consoleStoreState.activeSessionId = 'session-b'
    view.rerender(React.createElement(FilePanel))
    await waitFor(() => expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('root-home'))
  })
  it('keeps search query after opening favorite directory shortcut', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'project' } })
    expect(input.value).toBe('project')
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
    expect(input.value).toBe('project')
  })
  it('uses mobile back event to return from preview and directory levels', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('index.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByText('index.ts'))
    expect(await screen.findByText('line-1')).toBeInTheDocument()
    const previewBack = { handled: false }
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: previewBack }))
    expect(previewBack.handled).toBe(true)
    await waitFor(() => expect(screen.queryByText('line-1')).not.toBeInTheDocument())
    const directoryBack = { handled: false }
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: directoryBack }))
    expect(directoryBack.handled).toBe(true)
    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument())
  })
  it('zooms markdown preview on mobile via toolbar buttons', async () => {
    vi.mocked(api.files.content).mockResolvedValueOnce({ path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z', binary: false, truncated: false, encoding: 'utf-8', content: '# 标题' })
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('guide.md'))
    expect(await screen.findByText('100%')).toBeInTheDocument()
    fireEvent.click(screen.getByText('+'))
    expect(screen.getByText('125%')).toBeInTheDocument()
    fireEvent.click(screen.getByText('−'))
    expect(screen.getByText('100%')).toBeInTheDocument()
    fireEvent.click(screen.getByText('↺'))
    expect(screen.getByText('100%')).toBeInTheDocument()
  })
  it('zooms image preview on mobile via toolbar buttons', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('downloads')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('photo.png'))
    expect(await screen.findByText('100%')).toBeInTheDocument()
    fireEvent.click(screen.getByText('+'))
    expect(screen.getByText('125%')).toBeInTheDocument()
  })
  it('renders markdown preview on mobile for .md files', async () => {
    vi.mocked(api.files.content).mockResolvedValueOnce({ path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z', binary: false, truncated: false, encoding: 'utf-8', content: '# 标题\n\n**加粗**' })
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('guide.md'))
    await waitFor(() => expect(vi.mocked(api.files.content)).toHaveBeenCalledWith('local', 'root-workspace', 'docs/guide.md'))
    expect(await screen.findByRole('heading', { name: '标题' })).toBeInTheDocument()
    expect(screen.getByText('加粗').tagName).toBe('STRONG')
  })
  it('wraps long lines in mobile file preview', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('index.ts'))
    const content = (await screen.findByText('line-1')).closest('span') as HTMLSpanElement
    expect(content.className).toContain('whitespace-pre-wrap')
  })
  it('enters mobile edit mode after confirmation and saves', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('index.ts'))
    fireEvent.click(await screen.findByText('Edit'))
    expect(screen.getByText('Enter edit mode?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Confirm'))
    const textarea = (await screen.findByLabelText('Edit')) as HTMLTextAreaElement
    expect(textarea.value).toBe('hello\nworld')
    fireEvent.change(textarea, { target: { value: 'hello\nworld\nchanged' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(vi.mocked(api.files.saveContent)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.files.saveContent)).toHaveBeenCalledWith('local', 'root-workspace', 'src/index.ts', 'hello\nworld\nchanged', '2026-05-26T00:00:00.000Z')
  })
  it('confirms before discarding unsaved mobile edits', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    fireEvent.click(await screen.findByText('index.ts'))
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.click(screen.getByText('Confirm'))
    const textarea = (await screen.findByLabelText('Edit')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('Exit editing'))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Discard and exit'))
    await waitFor(() => expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument())
    expect(vi.mocked(api.files.saveContent)).not.toHaveBeenCalled()
  })
  it('returns to previous directory on mobile after entering nested folders', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('nested')).toBeInTheDocument()
    fireEvent.click(screen.getByText('nested'))
    expect(await screen.findByText('deep.ts')).toBeInTheDocument()
    const directoryBack = { handled: false }
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: directoryBack }))
    expect(directoryBack.handled).toBe(true)
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(screen.queryByText('deep.ts')).not.toBeInTheDocument()
  })
  it('handles mobile back inside the workspace picker', async () => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138.0.0.0 Mobile Safari/537.36' })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    render(React.createElement(FilePanel, { mode: 'picker' }))
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('index.ts')).toBeInTheDocument()
    const directoryBack = { handled: false }
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: directoryBack }))
    expect(directoryBack.handled).toBe(true)
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument())
    expect(screen.getByText('docs')).toBeInTheDocument()
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  })
  it('opens content search preview at matched line', async () => {
    render(React.createElement(FilePanel))
    fireEvent.click(screen.getByRole('button', { name: 'content' }))
    fireEvent.change(screen.getByPlaceholderText('Search file content'), { target: { value: 'needle' } })
    fireEvent.click((await screen.findByText('guide.md')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText(/L42:/)).toBeInTheDocument()
    expect(screen.getByText(/needle here/)).toBeInTheDocument()
  })
  it('clears search query from compact clear button', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    const clearButton = screen.getByRole('button', { name: 'Clear search' })
    expect(clearButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'docs' } })
    expect(clearButton).not.toBeDisabled()
    fireEvent.click(clearButton)
    expect(input.value).toBe('')
    expect(clearButton).toBeDisabled()
  })
  it('filters root list by file type', async () => {
    render(React.createElement(FilePanel))
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    expect(screen.queryByText('src')).not.toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dotfiles' }))
    expect(await screen.findByText('.env')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dir' }))
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
  })
  it('moves between visible files with arrow keys in the desktop tree', async () => {
    render(React.createElement(FilePanel))
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    fireEvent.click(screen.getByText('docs'))
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    const indexFile = screen.getByText('index.ts').closest('[role="button"]') as HTMLElement
    fireEvent.click(indexFile)
    fireEvent.keyDown(indexFile, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByText('guide.md').closest('[data-selected="true"]')).toBeInTheDocument())
    expect(screen.getByText('guide.md').closest('[role="button"]')).toHaveFocus()
    fireEvent.keyDown(screen.getByText('guide.md').closest('[role="button"]') as HTMLElement, { key: 'ArrowUp' })
    await waitFor(() => expect(screen.getByText('index.ts').closest('[data-selected="true"]')).toBeInTheDocument())
  })
  it('shows visible content search results when dotfiles are hidden', async () => {
    render(React.createElement(FilePanel))
    fireEvent.click(screen.getByRole('button', { name: 'content' }))
    fireEvent.change(screen.getByPlaceholderText('Search file content'), { target: { value: 'tmuxgo' } })
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.queryByText('.history')).not.toBeInTheDocument()
  })
  it('does not show no-results while content search is still loading', async () => {
    render(React.createElement(FilePanel))
    fireEvent.click(screen.getByRole('button', { name: 'content' }))
    fireEvent.change(screen.getByPlaceholderText('Search file content'), { target: { value: 'slow' } })
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('file.noResults')).not.toBeInTheDocument()
  })
  it('toggles dotfiles visibility from compact button', async () => {
    render(React.createElement(FilePanel))
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dotfiles' }))
    expect(await screen.findByText('.env')).toBeInTheDocument()
  })
  it('collapses expanded directories and clears cached children', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockClear()
    render(React.createElement(FilePanel))
    const collapseAll = screen.getByRole('button', { name: 'Collapse all' })
    expect(collapseAll).toBeDisabled()
    const src = await screen.findByText('src')
    fireEvent.click(src)
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(collapseAll).not.toBeDisabled()
    expect(vi.mocked(api.files.list).mock.calls.filter(([, rootId, path]) => rootId === 'root-workspace' && path === 'src')).toHaveLength(1)
    fireEvent.click(collapseAll)
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument())
    expect(collapseAll).toBeDisabled()
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(vi.mocked(api.files.list).mock.calls.filter(([, rootId, path]) => rootId === 'root-workspace' && path === 'src')).toHaveLength(2)
  })
  it('keeps directory collapsed when async child loading resolves after collapse', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        await new Promise<void>((resolve) => delayedSrcResolvers.push(resolve))
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    const src = await screen.findByText('src')
    fireEvent.click(src)
    fireEvent.click(src)
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    delayedSrcResolvers.splice(0).forEach((resolve) => resolve())
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument())
  })
  it('shows directory children after async loading without requiring a second toggle', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        await new Promise<void>((resolve) => delayedSrcResolvers.push(resolve))
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    fireEvent.click(await screen.findByText('src'))
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    delayedSrcResolvers.splice(0).forEach((resolve) => resolve())
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
  })
  it('shows loading state while directory children are pending', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        await new Promise<void>((resolve) => delayedSrcResolvers.push(resolve))
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
    delayedSrcResolvers.splice(0).forEach((resolve) => resolve())
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
  })
  it('shows retry state after directory loading fails and recovers on retry', async () => {
    const { api } = await import('@/lib/api')
    let attempts = 0
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        attempts += 1
        if (attempts === 1) throw new Error('temporary failure')
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('Load failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(attempts).toBe(2)
  })
  it('retries failed directory loading after app recovery', async () => {
    const { api } = await import('@/lib/api')
    let attempts = 0
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        attempts += 1
        if (attempts === 1) throw new Error('temporary failure')
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('Load failed')).toBeInTheDocument()
    window.dispatchEvent(new Event('tmuxgo-app-recovered'))
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
    expect(attempts).toBe(2)
  })
  it('reuses in-flight directory loading when toggled repeatedly', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockClear()
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-workspace' && path === 'src') {
        await new Promise<void>((resolve) => delayedSrcResolvers.push(resolve))
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    const src = await screen.findByText('src')
    fireEvent.click(src)
    fireEvent.click(src)
    fireEvent.click(src)
    expect(vi.mocked(api.files.list).mock.calls.filter(([, rootId, path]) => rootId === 'root-workspace' && path === 'src')).toHaveLength(1)
    delayedSrcResolvers.splice(0).forEach((resolve) => resolve())
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
  })
  it('renders all large directory entries', async () => {
    roots.push({ id: 'root-large', label: 'Large', path: '/large' })
    largeDirectoryItems = Array.from({ length: 121 }, (_, index) => ({ name: `file-${index}.txt`, path: `file-${index}.txt`, type: 'file', size: index, modifiedAt: '2026-05-26T00:00:00.000Z' }))
    render(React.createElement(FilePanel))
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'root-large' } })
    expect(await screen.findByText('file-79.txt')).toBeInTheDocument()
    expect(screen.getByText('file-80.txt')).toBeInTheDocument()
    expect(screen.getByText('file-120.txt')).toBeInTheDocument()
  })
})
