import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePanel } from './FilePanel'
import type { FileListResponse } from '@/types'

const clipboardMocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => ({ copied: true, source: 'system', unavailable: false })),
}))
const setFilePanelWidth = vi.fn()
const setFilePanelOpen = vi.fn()
const pushToast = vi.fn()
const invalidateQueries = vi.fn()
const delayedSrcResolvers: Array<() => void> = []
const preferencesGet = vi.fn(async () => ({ version: 1, updatedAt: '', customShortcuts: [], customShortcutsUpdatedAt: '', favoriteDirectories: [], favoriteDirectoriesUpdatedAt: '', sessionOrders: [], sessionOrdersUpdatedAt: '', uploadRateLimitKBps: 200, downloadRateLimitKBps: 200 }))
const preferencesUpdate = vi.fn(async (payload: any) => ({ version: 1, updatedAt: '', customShortcuts: [], customShortcutsUpdatedAt: '', favoriteDirectories: payload.favoriteDirectories || [], favoriteDirectoriesUpdatedAt: payload.favoriteDirectoriesUpdatedAt || '', sessionOrders: [], sessionOrdersUpdatedAt: '', uploadRateLimitKBps: payload.uploadRateLimitKBps || 200, downloadRateLimitKBps: payload.downloadRateLimitKBps || 200 }))

const roots = [
  { id: 'root-home', label: 'Home', path: '/home/guo' },
]
const getListData = (rootId: string, currentPath: string): FileListResponse => {
  if (rootId === 'root-home') {
    if (!currentPath) return { root: roots[0], path: '', breadcrumbs: [{ name: '/', path: '' }], items: [{ name: 'src', path: 'src', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'downloads', path: 'downloads', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: '.env', path: '.env', type: 'file', size: 4, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'src') return { root: roots[0], path: 'src', breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }], items: [{ name: 'nested', path: 'src/nested', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 12, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'src/nested') return { root: roots[0], path: 'src/nested', breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }, { name: 'nested', path: 'src/nested' }], items: [{ name: 'deep.ts', path: 'src/nested/deep.ts', type: 'file', size: 7, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'docs') return { root: roots[0], path: 'docs', breadcrumbs: [{ name: '/', path: '' }, { name: 'docs', path: 'docs' }], items: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'project') return { root: roots[0], path: 'project', breadcrumbs: [{ name: '/', path: '' }, { name: 'project', path: 'project' }], items: [{ name: 'demo.txt', path: 'project/demo.txt', type: 'file', size: 8, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'downloads') return { root: roots[0], path: 'downloads', breadcrumbs: [{ name: '/', path: '' }, { name: 'downloads', path: 'downloads' }], items: [{ name: 'archive.zip', path: 'downloads/archive.zip', type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'photo.png', path: 'downloads/photo.png', type: 'file', size: 48, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
  }
  return { root: roots.find((item) => item.id === rootId) || roots[0], path: currentPath, breadcrumbs: [{ name: '/', path: '' }], items: [] }
}

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector?: any) => {
    const state = { activeHostId: 'local', filePanelWidth: 360, setFilePanelWidth, setFilePanelOpen, pushToast }
    return typeof selector === 'function' ? selector(state) : state
  }) as any,
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))
vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: roots }),
  useFileList: (_hostId: string, nextRootId: string, nextCurrentPath: string, enabled = true) => {
    if (!enabled) return { data: undefined, isLoading: false }
    return { data: getListData(nextRootId || 'root-home', nextCurrentPath), isLoading: false }
  },
  useFilePreview: (_hostId: string, _rootId: string, path: string, line = 1) => ({ data: path ? path.endsWith('.png') ? { path, type: 'file', size: 48, modifiedAt: '2026-05-26T00:00:00.000Z', binary: true, truncated: false, reason: 'binary-file', lines: [] } : { path, type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z', binary: false, truncated: false, lines: [{ number: line, content: `line-${line}` }] } : null }),
  useFileSearch: (_hostId: string, _rootId: string, mode: string, query: string, basePath = '') => {
    if (mode === 'content' && query === 'needle') return { data: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z', matches: [{ number: 42, content: 'needle here' }] }], isFetching: false }
    if (query === 'docs' && !basePath) return { data: [{ name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    if (query === 'project' && !basePath) return { data: [{ name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    return { data: [], isFetching: false }
  },
}))
vi.mock('@/lib/clipboard-text', () => ({
  writeClipboardText: clipboardMocks.writeClipboardText,
}))
vi.mock('@/lib/api', () => ({
  api: {
    files: {
      list: vi.fn(async (_hostId: string, rootId: string, path = '') => getListData(rootId, path)),
      createFile: vi.fn(async () => ({ ok: true })),
      createDirectory: vi.fn(async () => ({ ok: true })),
      rename: vi.fn(async () => ({ ok: true, item: { path: 'renamed.txt' } })),
      remove: vi.fn(async () => ({ ok: true })),
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
    if (key === 'file.removeFavorite') return 'Unfavorite'
    if (key === 'file.clearSearch') return 'Clear search'
    if (key === 'file.copyPath') return 'Copy path'
    return key
  } }),
}))

describe('FilePanel', () => {
  beforeEach(() => {
    localStorage.clear()
    setFilePanelWidth.mockReset()
    setFilePanelOpen.mockReset()
    pushToast.mockReset()
    clipboardMocks.writeClipboardText.mockClear()
    preferencesGet.mockClear()
    preferencesUpdate.mockClear()
    delayedSrcResolvers.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return window.setTimeout(() => cb(0), 0)
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows home as the default quick access root', async () => {
    render(React.createElement(FilePanel))
    expect(await screen.findByRole('option', { name: 'Home' })).toBeInTheDocument()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('root-home')
    expect(screen.queryByRole('option', { name: 'Workspace' })).not.toBeInTheDocument()
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
    expect(favorites.map((item: any) => `${item.rootId}:${item.path}`)).toEqual(['root-home:src'])
    fireEvent.click(screen.getByRole('button', { name: 'Unfavorite src' }))
    favorites = JSON.parse(localStorage.getItem('tmuxgo-favorite-directories') || '[]')
    expect(favorites).toEqual([])
  })

  it('opens a favorite directory shortcut on mobile', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    const favoriteButtons = await screen.findAllByRole('button', { name: 'Home · project' })
    fireEvent.click(favoriteButtons[0])
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
  })

  it('shows favorite directories as selectable roots', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    expect(await screen.findByRole('option', { name: 'project' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('demo.txt')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument()
  })
  it('opens file from favorite root with full relative path', async () => {
    const onOpenFile = vi.fn()
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel, { onOpenFile }))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
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
      rootId: 'root-home',
      path: 'downloads/photo.png',
      absolutePath: '/home/guo/downloads/photo.png',
    })
  })
  it('copies file path from favorite root with full absolute path', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
    fireEvent.contextMenu(await screen.findByText('demo.txt'))
    fireEvent.click(await screen.findByText('Copy path'))
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith('/home/guo/project/demo.txt')
  })
  it('removes selected favorite root from header without affecting home', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
    const removeBtn = await screen.findByRole('button', { name: 'Unfavorite' })
    fireEvent.click(removeBtn)
    await waitFor(() => expect(screen.queryByRole('option', { name: 'project' })).not.toBeInTheDocument())
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('root-home')
    const favorites = JSON.parse(localStorage.getItem('tmuxgo-favorite-directories') || '[]')
    expect(favorites).toEqual([])
  })

  it('expands a searched directory in place on desktop while keeping name search active', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByText('docs'))
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    expect(input.value).toBe('docs')
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument()
  })
  it('shows full path on hover for filtered directories and files', async () => {
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'src' } })
    const directory = await screen.findByTitle('/home/guo/src')
    expect(directory).toHaveTextContent('src')
    fireEvent.click(directory)
    expect(await screen.findByTitle('/home/guo/src/index.ts')).toHaveTextContent('index.ts')
  })

  it('enters a searched directory on mobile while keeping name search active', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
    expect(input.value).toBe('docs')
    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '/' }))
    expect(await screen.findByText('docs')).toBeInTheDocument()
  })
  it('keeps search query after switching root', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    await screen.findByRole('option', { name: 'project' })
    fireEvent.change(input, { target: { value: 'project' } })
    expect(input.value).toBe('project')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
    await waitFor(() => expect(screen.getByText('project')).toBeInTheDocument())
    expect(input.value).toBe('project')
  })
  it('keeps search query after opening favorite directory shortcut', async () => {
    localStorage.setItem('tmuxgo-favorite-directories', JSON.stringify([{ rootId: 'root-home', rootPath: '/home/guo', name: 'project', path: 'project' }]))
    render(React.createElement(FilePanel))
    const input = screen.getByPlaceholderText('Search file names') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'project' } })
    expect(input.value).toBe('project')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'favorite:root-home:project' } })
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
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dotfiles' }))
    expect(await screen.findByText('.env')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dir' }))
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
  })
  it('toggles dotfiles visibility from compact button', async () => {
    render(React.createElement(FilePanel))
    expect(screen.queryByText('.env')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dotfiles' }))
    expect(await screen.findByText('.env')).toBeInTheDocument()
  })
  it('keeps directory collapsed when async child loading resolves after collapse', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-home' && path === 'src') {
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
  it('reuses in-flight directory loading when toggled repeatedly', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.files.list).mockClear()
    vi.mocked(api.files.list).mockImplementation(async (_hostId: string, rootId: string, path = '') => {
      if (rootId === 'root-home' && path === 'src') {
        await new Promise<void>((resolve) => delayedSrcResolvers.push(resolve))
      }
      return getListData(rootId, path)
    })
    render(React.createElement(FilePanel))
    const src = await screen.findByText('src')
    fireEvent.click(src)
    fireEvent.click(src)
    fireEvent.click(src)
    expect(vi.mocked(api.files.list).mock.calls.filter(([, rootId, path]) => rootId === 'root-home' && path === 'src')).toHaveLength(1)
    delayedSrcResolvers.splice(0).forEach((resolve) => resolve())
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument())
  })
})
