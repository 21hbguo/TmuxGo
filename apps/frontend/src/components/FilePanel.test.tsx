import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePanel } from './FilePanel'

const setFilePanelWidth = vi.fn()
const setFilePanelOpen = vi.fn()
const pushToast = vi.fn()
const writeClipboardText = vi.fn(async () => ({ copied: true, source: 'system', unavailable: false }))

const roots = [
  { id: 'root-workspace', label: 'Workspace', path: '/workspace' },
  { id: 'root-home', label: 'Home', path: '/home/guo' },
]
const getListData = (rootId: string, currentPath: string) => {
  if (rootId === 'root-workspace') {
    if (!currentPath) return { root: roots[0], path: '', breadcrumbs: [{ name: '/', path: '' }], items: [{ name: 'src', path: 'src', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'src') return { root: roots[0], path: 'src', breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }], items: [{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 12, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'docs') return { root: roots[0], path: 'docs', breadcrumbs: [{ name: '/', path: '' }, { name: 'docs', path: 'docs' }], items: [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 16, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
  }
  if (rootId === 'root-home') {
    if (!currentPath) return { root: roots[1], path: '', breadcrumbs: [{ name: '/', path: '' }], items: [{ name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }, { name: 'downloads', path: 'downloads', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'project') return { root: roots[1], path: 'project', breadcrumbs: [{ name: '/', path: '' }, { name: 'project', path: 'project' }], items: [{ name: 'demo.txt', path: 'project/demo.txt', type: 'file', size: 8, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
    if (currentPath === 'downloads') return { root: roots[1], path: 'downloads', breadcrumbs: [{ name: '/', path: '' }, { name: 'downloads', path: 'downloads' }], items: [{ name: 'archive.zip', path: 'downloads/archive.zip', type: 'file', size: 32, modifiedAt: '2026-05-26T00:00:00.000Z' }] }
  }
  return { root: roots.find((item) => item.id === rootId) || roots[0], path: currentPath, breadcrumbs: [{ name: '/', path: '' }], items: [] }
}

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector?: any) => {
    const state = { filePanelWidth: 360, setFilePanelWidth, setFilePanelOpen, pushToast }
    return typeof selector === 'function' ? selector(state) : state
  }) as any,
}))
vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: roots }),
  useFileList: (nextRootId: string, nextCurrentPath: string, enabled = true) => {
    if (!enabled) return { data: undefined, isLoading: false }
    return { data: getListData(nextRootId || 'root-workspace', nextCurrentPath), isLoading: false }
  },
  useFilePreview: () => ({ data: null }),
  useFileSearch: (_rootId: string, _mode: string, query: string) => {
    if (query === 'docs') return { data: [{ name: 'docs', path: 'docs', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    if (query === 'project') return { data: [{ name: 'project', path: 'project', type: 'directory', size: 0, modifiedAt: '2026-05-26T00:00:00.000Z' }], isFetching: false }
    return { data: [], isFetching: false }
  },
}))
vi.mock('@/lib/clipboard-text', () => ({
  writeClipboardText: (...args: any[]) => writeClipboardText(...args),
}))

describe('FilePanel', () => {
  beforeEach(() => {
    localStorage.clear()
    setFilePanelWidth.mockReset()
    setFilePanelOpen.mockReset()
    pushToast.mockReset()
    writeClipboardText.mockClear()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows workspace and home quick access roots', async () => {
    render(React.createElement(FilePanel))
    expect(await screen.findByRole('button', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument()
  })

  it('expands and collapses directories on desktop', async () => {
    render(React.createElement(FilePanel))
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
    expect(await screen.findByText('index.ts')).toBeInTheDocument()
    fireEvent.click((await screen.findByText('src')).closest('button') as HTMLButtonElement)
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

  it('expands a searched directory on desktop only after click', async () => {
    render(React.createElement(FilePanel))
    fireEvent.change(screen.getByPlaceholderText('Search file names'), { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
  })

  it('enters a searched directory on mobile only after click', async () => {
    render(React.createElement(FilePanel, { mode: 'mobile' }))
    fireEvent.change(screen.getByPlaceholderText('Search file names'), { target: { value: 'docs' } })
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument()
    fireEvent.click((await screen.findByText('docs')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument())
  })
})
