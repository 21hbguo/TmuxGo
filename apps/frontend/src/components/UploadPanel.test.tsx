import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadPanel } from './UploadPanel'
import { api } from '@/lib/api'
import { MAX_UPLOAD_FILE_BYTES } from '@/lib/file-meta'

const removeUploadJob = vi.fn()
const clearFinishedUploadJobs = vi.fn()
const openUploadDialog = vi.fn()
const setStagedUploadFiles = vi.fn()
const pushToast = vi.fn()

let hostsData: any[] = [
  { id: 'local', name: 'Local', status: 'online' },
  { id: 'remote-a', name: 'Remote A', status: 'online' },
]
const rootsByHost: Record<string, any[]> = {
  local: [{ id: 'root-workspace', label: 'Workspace', path: '/workspace' }],
  'remote-a': [{ id: 'root-data', label: 'Data', path: '/data' }],
}
const storeState: any = {
  activeHostId: 'local',
  activePaneId: 'local:pane-a',
  uploadJobs: [],
  stagedUploadFiles: [],
}
const storeForSelector = () => ({
  ...storeState,
  removeUploadJob,
  clearFinishedUploadJobs,
  openUploadDialog,
  setStagedUploadFiles,
  pushToast,
})

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign((selector: any) => selector(storeForSelector()), {
    getState: () => storeForSelector(),
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: hostsData }),
  useFileRoots: (hostId: string) => ({ data: rootsByHost[hostId] || [] }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    files: {
      defaultUploadTarget: vi.fn(async (hostId: string) =>
        hostId === 'remote-a'
          ? { rootId: 'root-data', path: 'inbox' }
          : { rootId: 'root-workspace', path: 'downloads' },
      ),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}))

const file = (name: string, size = 4) => new File(['x'.repeat(size)], name, { type: 'text/plain' })

describe('UploadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hostsData = [
      { id: 'local', name: 'Local', status: 'online' },
      { id: 'remote-a', name: 'Remote A', status: 'online' },
    ]
    storeState.activeHostId = 'local'
    storeState.uploadJobs = []
    storeState.stagedUploadFiles = []
  })

  it('mobile mode exposes a visible choose-files entry that stages via the global picker', async () => {
    const events: any[] = []
    const onPick = (e: Event) => events.push((e as CustomEvent).detail)
    window.addEventListener('tmuxgo-pick-upload-files', onPick)
    try {
      render(React.createElement(UploadPanel, { mode: 'mobile' }))
      await waitFor(() => expect(api.files.defaultUploadTarget).toHaveBeenCalledWith('local', 'local:pane-a'))
      fireEvent.click(screen.getByRole('button', { name: /uploadTab.chooseFiles/ }))
      // stage 模式：文件进全局暂存列表在页面展示，而非直接弹确认
      expect(events).toEqual([{ stage: true }])
    } finally {
      window.removeEventListener('tmuxgo-pick-upload-files', onPick)
    }
  })

  it('lists staged files with name/size/type and supports removal and clear', () => {
    storeState.stagedUploadFiles = [file('demo.txt', 10), file('a.bin', 2048)]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    expect(screen.getByText('demo.txt')).toBeInTheDocument()
    expect(screen.getByText('a.bin')).toBeInTheDocument()
    expect(screen.getByText(/txt · text\/plain/)).toBeInTheDocument()
    const removes = screen.getAllByRole('button', { name: 'uploadTab.remove' })
    fireEvent.click(removes[0])
    expect(setStagedUploadFiles).toHaveBeenCalledWith([storeState.stagedUploadFiles[1]])
    fireEvent.click(screen.getByRole('button', { name: 'uploadTab.clear' }))
    expect(setStagedUploadFiles).toHaveBeenCalledWith([])
  })

  it('labels unknown/no-extension files as octet-stream and advertises any-type uploads', () => {
    storeState.stagedUploadFiles = [
      new File(['x'], 'weights.gguf', { type: '' }),
      new File(['x'], 'noext', { type: '' }),
    ]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    // 类型不受限：未知 MIME 显示 octet-stream 而不是被拦下
    expect(screen.getByText('gguf · application/octet-stream')).toBeInTheDocument()
    expect(screen.getByText('application/octet-stream · uploadTab.noExt')).toBeInTheDocument()
    expect(screen.getByText(/uploadTab\.anyType/)).toBeInTheDocument()
  })

  it('submits staged files through the existing confirm dialog with the chosen host/target', async () => {
    storeState.stagedUploadFiles = [file('demo.txt', 10)]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    await waitFor(() => expect(api.files.defaultUploadTarget).toHaveBeenCalledWith('local', 'local:pane-a'))
    const hostSelect = screen.getAllByRole('combobox').find((el) => el.getAttribute('aria-label') === 'uploadTab.host')
    fireEvent.click(hostSelect!)
    const option = await waitFor(() => {
      const el = document.querySelector('[role="option"][data-value="remote-a"]')
      if (!el) throw new Error('host option missing')
      return el
    })
    fireEvent.click(option)
    // 切主机必须重新解析目标——绝不能沿用 local 的目录
    await waitFor(() => expect(api.files.defaultUploadTarget).toHaveBeenCalledWith('remote-a', 'local:pane-a'))
    await waitFor(() => expect(document.querySelector('[role="combobox"][data-value="root-data"]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /uploadTab\.submit/ }))
    expect(openUploadDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'remote-a',
        preferredRootId: 'root-data',
        preferredPath: 'inbox',
      }),
    )
    expect(openUploadDialog.mock.calls[0][0].files).toHaveLength(1)
    expect(setStagedUploadFiles).toHaveBeenCalledWith([])
  })

  it('lists jobs including failure reasons and supports removing them', () => {
    storeState.uploadJobs = [
      {
        id: 'j1',
        files: [{ name: 'big.iso', size: 1000 }],
        targetRootId: 'root-workspace',
        targetPath: 'downloads',
        insertPaths: false,
        loadedBytes: 500,
        totalBytes: 1000,
        status: 'uploading',
        createdAt: '2026-09-26T00:00:00Z',
      },
      {
        id: 'j2',
        files: [{ name: 'bad.bin', size: 10 }],
        targetRootId: 'root-workspace',
        targetPath: '',
        insertPaths: false,
        loadedBytes: 0,
        totalBytes: 10,
        status: 'error',
        errorMessage: 'EACCES: permission denied',
        createdAt: '2026-09-26T00:00:00Z',
        finishedAt: '2026-09-26T00:00:01Z',
      },
    ]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    expect(screen.getByText('big.iso')).toBeInTheDocument()
    expect(screen.getByText('EACCES: permission denied')).toBeInTheDocument()
    const closes = screen.getAllByRole('button', { name: 'uploadQueue.close' })
    fireEvent.click(closes[1])
    expect(removeUploadJob).toHaveBeenCalledWith('j2')
  })

  it('retries a failed job by reopening the confirm dialog with the original snapshot', () => {
    const sourceFiles = [file('retry.bin', 8)]
    storeState.uploadJobs = [
      {
        id: 'j-retry',
        hostId: 'remote-a',
        files: [{ name: 'retry.bin', size: 8 }],
        sourceFiles,
        targetRootId: 'root-data',
        targetPath: 'inbox',
        insertPaths: true,
        loadedBytes: 4,
        totalBytes: 8,
        status: 'error',
        errorMessage: 'boom',
        createdAt: '2026-09-26T00:00:00Z',
      },
      // 无 sourceFiles 的失败 job（如历史遗留）不提供重试
      {
        id: 'j-nofile',
        hostId: 'local',
        files: [{ name: 'gone.bin', size: 1 }],
        targetRootId: 'root-workspace',
        targetPath: '',
        insertPaths: false,
        loadedBytes: 0,
        totalBytes: 1,
        status: 'error',
        createdAt: '2026-09-26T00:00:00Z',
      },
    ]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    expect(screen.getAllByRole('button', { name: 'uploadQueue.retry' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'uploadQueue.retry' }))
    // 旧失败记录由弹窗在新任务提交后取代（replacesJobId）——点击瞬间不删
    expect(openUploadDialog).toHaveBeenCalledWith({
      files: sourceFiles,
      hostId: 'remote-a',
      preferredRootId: 'root-data',
      preferredPath: 'inbox',
      insertPaths: true,
      replacesJobId: 'j-retry',
    })
    expect(removeUploadJob).not.toHaveBeenCalledWith('j-retry')
  })

  it('copies uploaded absolute paths from a successful job', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    storeState.uploadJobs = [
      {
        id: 'j-ok',
        hostId: 'local',
        files: [{ name: 'a.png', size: 4 }],
        targetRootId: 'root-workspace',
        targetPath: 'dl',
        insertPaths: false,
        loadedBytes: 4,
        totalBytes: 4,
        status: 'success',
        createdAt: '2026-09-26T00:00:00Z',
        result: {
          ok: true,
          target: {
            rootId: 'root-workspace',
            rootLabel: 'w',
            rootPath: '/w',
            path: 'dl',
            absolutePath: '/w/dl',
            source: 'pane',
          },
          files: [
            { name: 'a.png', path: 'dl/a.png', absolutePath: '/w/dl/a.png', size: 4 },
            { name: 'b.png', path: 'dl/b.png', absolutePath: '/w/dl/b.png', size: 4 },
          ],
        },
      },
    ]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    fireEvent.click(screen.getByRole('button', { name: 'uploadQueue.copyPaths' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/w/dl/a.png\n/w/dl/b.png'))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
    vi.unstubAllGlobals()
  })

  it('reports copy failure when the clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    storeState.uploadJobs = [
      {
        id: 'j-ok',
        hostId: 'local',
        files: [{ name: 'a.png', size: 4 }],
        targetRootId: 'root-workspace',
        targetPath: 'dl',
        insertPaths: false,
        loadedBytes: 4,
        totalBytes: 4,
        status: 'success',
        createdAt: '2026-09-26T00:00:00Z',
        result: {
          ok: true,
          target: {
            rootId: 'root-workspace',
            rootLabel: 'w',
            rootPath: '/w',
            path: 'dl',
            absolutePath: '/w/dl',
            source: 'pane',
          },
          files: [{ name: 'a.png', path: 'dl/a.png', absolutePath: '/w/dl/a.png', size: 4 }],
        },
      },
    ]
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    fireEvent.click(screen.getByRole('button', { name: 'uploadQueue.copyPaths' }))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })))
    vi.unstubAllGlobals()
  })

  it('stages dropped real files and ignores non-file drags', () => {
    const { container } = render(React.createElement(UploadPanel, { mode: 'mobile' }))
    const zone = container.querySelector('.tmuxgo-scrollbar')!
    const dropped = file('drop.png', 10)
    fireEvent.drop(zone, { dataTransfer: { files: [dropped], types: ['Files'] } })
    expect(setStagedUploadFiles).toHaveBeenCalledWith([dropped])
    // 面板内部条目拖拽不带 files，不触发暂存
    fireEvent.drop(zone, { dataTransfer: { files: [], types: ['tmuxgo/file'] } })
    expect(setStagedUploadFiles).toHaveBeenCalledTimes(1)
  })

  it('filters dropped directories out of staging', () => {
    const { container } = render(React.createElement(UploadPanel, { mode: 'mobile' }))
    const zone = container.querySelector('.tmuxgo-scrollbar')!
    const dirEntry = { isDirectory: true }
    const fileEntry = { isDirectory: false }
    const dropped = file('real.txt', 6)
    const pseudoDir = file('somedir', 0)
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [dropped, pseudoDir],
        types: ['Files'],
        items: [{ webkitGetAsEntry: () => fileEntry }, { webkitGetAsEntry: () => dirEntry }],
      },
    })
    expect(setStagedUploadFiles).toHaveBeenCalledWith([dropped])
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }))
  })

  it('stages clipboard files on paste and leaves text paste untouched', () => {
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    const pasted = file('clip.txt', 5)
    fireEvent.paste(document, { clipboardData: { files: [pasted] } })
    expect(setStagedUploadFiles).toHaveBeenCalledWith([pasted])
    fireEvent.paste(document, { clipboardData: { files: [], getData: () => 'plain text' } })
    expect(setStagedUploadFiles).toHaveBeenCalledTimes(1)
  })

  it('toasts rejections instead of staging oversized files', () => {
    const oversized = file('huge.iso', 4)
    Object.defineProperty(oversized, 'size', { value: MAX_UPLOAD_FILE_BYTES + 1 })
    render(React.createElement(UploadPanel, { mode: 'mobile' }))
    fireEvent.paste(document, { clipboardData: { files: [oversized] } })
    expect(setStagedUploadFiles).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  it('renders empty-jobs placeholder and closes via header button', () => {
    const onClose = vi.fn()
    render(React.createElement(UploadPanel, { mode: 'mobile', onClose }))
    expect(screen.getByText('uploadTab.noJobs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
