import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadConfirmDialog } from './UploadConfirmDialog'
import { api } from '@/lib/api'

const closeUploadDialog = vi.fn()
const pushToast = vi.fn()
const addUploadJob = vi.fn()
const updateUploadJob = vi.fn()
const removeUploadJob = vi.fn()
const setActivePane = vi.fn()

const roots = [
  { id: 'root-workspace', label: 'Workspace', path: '/workspace' },
  { id: 'root-home', label: 'Home', path: '/home/user' },
]
let panesData: any = {
  panes: [
    { id: 'local:pane-a', title: 'shell-a', windowName: 'main', tmuxPaneId: '%1', windowId: 'local:@1', active: true },
    { id: 'local:pane-b', title: 'shell-b', windowName: 'main', tmuxPaneId: '%2', windowId: 'local:@1' },
  ],
  activeWindowId: 'local:@1',
}

const storeState: any = {
  uploadRequest: null,
  activeHostId: 'local',
  activeSessionId: 'session-a',
  activePaneId: 'local:pane-a',
}
const storeForSelector = () => ({
  ...storeState,
  closeUploadDialog,
  pushToast,
  addUploadJob,
  updateUploadJob,
  removeUploadJob,
})

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign((selector: any) => selector(storeForSelector()), {
    getState: () => ({ ...storeForSelector(), setActivePane }),
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: roots }),
  useSessionSnapshot: () => ({ data: panesData }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { uploadRateLimitKBps: 5120 } }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    files: {
      roots: vi.fn(async () => roots),
      defaultUploadTarget: vi.fn(async () => ({ rootId: 'root-workspace', rootPath: '/workspace', path: 'downloads' })),
      temporaryUploadTarget: vi.fn(async () => ({
        rootId: 'app-tmp',
        rootLabel: 'Temp',
        rootPath: '/tmp/x',
        path: '',
      })),
      upload: vi.fn(async () => ({ files: [{ absolutePath: '/workspace/downloads/demo.txt' }] })),
    },
    panes: {
      select: vi.fn(async () => ({ ok: true })),
    },
    windows: {
      select: vi.fn(async () => ({ windows: [] })),
    },
    system: {
      tasks: vi.fn(async () => ({ tasks: [] })),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}))

const file = (name: string, size = 4) => new File(['x'.repeat(size)], name, { type: 'text/plain' })
const setRequest = (request: any) => {
  storeState.uploadRequest = request
}
const insertCheckbox = () => {
  const label = screen.getByText('upload.insertPaths').closest('label')
  const input = label?.querySelector('input[type="checkbox"]')
  if (!input) throw new Error('insert checkbox not rendered')
  return input as HTMLInputElement
}

describe('UploadConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.activeHostId = 'local'
    storeState.activePaneId = 'local:pane-a'
    panesData = {
      panes: [
        {
          id: 'local:pane-a',
          title: 'shell-a',
          windowName: 'main',
          tmuxPaneId: '%1',
          windowId: 'local:@1',
          active: true,
        },
        { id: 'local:pane-b', title: 'shell-b', windowName: 'main', tmuxPaneId: '%2', windowId: 'local:@1' },
      ],
      activeWindowId: 'local:@1',
    }
    setRequest(null)
  })

  it('defaults insertPaths off for file uploads and posts to the request host with target fields', async () => {
    const pasteEvents: string[] = []
    const onPaste = (e: Event) => pasteEvents.push((e as CustomEvent).detail?.text || '')
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    setRequest({ files: [file('demo.txt', 10)], preferredRootId: 'root-workspace', preferredPath: 'src' })
    render(React.createElement(UploadConfirmDialog))
    expect(insertCheckbox().checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    await waitFor(() => expect(api.files.upload).toHaveBeenCalledTimes(1))
    // 默认关闭：上传成功也不向终端派发任何内容
    expect(pasteEvents).toEqual([])
    window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    const [hostId, body] = vi.mocked(api.files.upload).mock.calls[0] as any[]
    expect(hostId).toBe('local')
    expect(body.get('targetRootId')).toBe('root-workspace')
    expect(body.get('targetPath')).toBe('src')
    expect((body.getAll('files') as File[]).map((f) => f.name)).toEqual(['demo.txt'])
    expect(addUploadJob).toHaveBeenCalledWith(
      expect.objectContaining({ insertPaths: false, targetRootId: 'root-workspace' }),
    )
    await waitFor(() =>
      expect(updateUploadJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'success' })),
    )
  })

  it('removes the replaced failed job only after the retry submission goes through', async () => {
    setRequest({
      files: [file('retry.bin')],
      hostId: 'local',
      preferredRootId: 'root-workspace',
      preferredPath: 'downloads',
      replacesJobId: 'old-failed-job',
    })
    render(React.createElement(UploadConfirmDialog))
    // 取消不重试：旧失败记录必须保留
    fireEvent.click(screen.getByRole('button', { name: 'upload.cancel' }))
    expect(removeUploadJob).not.toHaveBeenCalled()
  })

  it('drops the replaced failed job once the retry is submitted', async () => {
    setRequest({
      files: [file('retry.bin')],
      hostId: 'local',
      preferredRootId: 'root-workspace',
      preferredPath: 'downloads',
      replacesJobId: 'old-failed-job',
    })
    render(React.createElement(UploadConfirmDialog))
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    await waitFor(() => expect(removeUploadJob).toHaveBeenCalledWith('old-failed-job'))
  })

  it('honours an explicit uploadRequest.hostId instead of silently falling back to the active host', async () => {
    setRequest({ files: [file('a.txt')], hostId: 'host-b', preferredRootId: 'root-workspace', preferredPath: '' })
    render(React.createElement(UploadConfirmDialog))
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    await waitFor(() => expect(api.files.upload).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.files.upload).mock.calls[0][0]).toBe('host-b')
  })

  it('pre-checks insert only for explicit insertPaths requests (paste flow)', async () => {
    setRequest({ files: [file('a.txt')], temporary: true, insertPaths: true })
    render(React.createElement(UploadConfirmDialog))
    await waitFor(() => expect(insertCheckbox().checked).toBe(true))
  })

  it('on insert, switches to the chosen pane then routes through paste confirmation — never raw terminal input', async () => {
    const pasteEvents: string[] = []
    const rawEvents: string[] = []
    const onPaste = (e: Event) => pasteEvents.push((e as CustomEvent).detail?.text || '')
    const onRaw = () => rawEvents.push('raw')
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    window.addEventListener('tmuxgo-terminal-input', onRaw)
    try {
      setRequest({ files: [file('demo.txt')], preferredRootId: 'root-workspace', preferredPath: 'downloads' })
      render(React.createElement(UploadConfirmDialog))
      fireEvent.click(insertCheckbox())
      const paneSelect = screen
        .getAllByRole('combobox')
        .find((el) => el.getAttribute('aria-label') === 'upload.insertPane')
      expect(paneSelect).toBeTruthy()
      fireEvent.click(paneSelect!)
      const option = await waitFor(() => {
        const el = document.querySelector('[role="option"][data-value="local:pane-b"]')
        if (!el) throw new Error('pane option missing')
        return el
      })
      fireEvent.click(option)
      fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
      await waitFor(() =>
        expect(updateUploadJob).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ status: 'success' }),
        ),
      )
      await waitFor(() => expect(pasteEvents).toEqual(["'/workspace/downloads/demo.txt'"]))
      expect(vi.mocked(api.panes.select)).toHaveBeenCalledWith('local:pane-b')
      expect(setActivePane).toHaveBeenCalledWith('local:pane-b')
      expect(rawEvents).toEqual([])
    } finally {
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
      window.removeEventListener('tmuxgo-terminal-input', onRaw)
    }
  })

  it('inserts only server-returned paths, shell-quoted against spaces/$/quotes', async () => {
    vi.mocked(api.files.upload).mockResolvedValueOnce({
      files: [{ absolutePath: `/workspace/my dir/we'ird $name\`x\`.txt` }],
    } as any)
    const pasteEvents: string[] = []
    const onPaste = (e: Event) => pasteEvents.push((e as CustomEvent).detail?.text || '')
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    try {
      setRequest({ files: [file('weird')], preferredRootId: 'root-workspace', preferredPath: '' })
      render(React.createElement(UploadConfirmDialog))
      fireEvent.click(insertCheckbox())
      fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
      await waitFor(() => expect(pasteEvents).toHaveLength(1))
      // POSIX 单引号 + '\'' 转义：空格/$/`/单引号均不会引发命令执行
      expect(pasteEvents[0]).toBe(`'/workspace/my dir/we'\\''ird $name\`x\`.txt'`)
      // toast 带目标 pane 名
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }))
    } finally {
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    }
  })

  it('failed upload never dispatches paste and reports the skip', async () => {
    vi.mocked(api.files.upload).mockRejectedValueOnce(new Error('disk full'))
    const pasteEvents: string[] = []
    const onPaste = (e: Event) => pasteEvents.push((e as CustomEvent).detail?.text || '')
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    try {
      setRequest({ files: [file('demo.txt')], preferredRootId: 'root-workspace', preferredPath: '' })
      render(React.createElement(UploadConfirmDialog))
      fireEvent.click(insertCheckbox())
      fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'info', message: expect.stringContaining('upload.insertSkipped') }),
        ),
      )
      expect(pasteEvents).toEqual([])
    } finally {
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    }
  })

  it('surfaces pane-select failure instead of silently writing to the wrong pane', async () => {
    vi.mocked(api.panes.select).mockResolvedValueOnce({ ok: false, error: 'pane gone' } as any)
    const pasteEvents: string[] = []
    const onPaste = (e: Event) => pasteEvents.push((e as CustomEvent).detail?.text || '')
    window.addEventListener('tmuxgo-request-terminal-paste', onPaste)
    try {
      setRequest({ files: [file('demo.txt')], preferredRootId: 'root-workspace', preferredPath: '' })
      render(React.createElement(UploadConfirmDialog))
      fireEvent.click(insertCheckbox())
      const paneSelect = screen
        .getAllByRole('combobox')
        .find((el) => el.getAttribute('aria-label') === 'upload.insertPane')
      fireEvent.click(paneSelect!)
      const option = await waitFor(() => {
        const el = document.querySelector('[role="option"][data-value="local:pane-b"]')
        if (!el) throw new Error('pane option missing')
        return el
      })
      fireEvent.click(option)
      fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'pane gone' })),
      )
      expect(pasteEvents).toEqual([])
    } finally {
      window.removeEventListener('tmuxgo-request-terminal-paste', onPaste)
    }
  })

  it('surfaces upload errors on the job and as a toast', async () => {
    vi.mocked(api.files.upload).mockRejectedValueOnce(new Error('EACCES: permission denied'))
    setRequest({ files: [file('demo.txt')], preferredRootId: 'root-workspace', preferredPath: '' })
    render(React.createElement(UploadConfirmDialog))
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    await waitFor(() =>
      expect(updateUploadJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'error', errorMessage: 'EACCES: permission denied' }),
      ),
    )
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'EACCES: permission denied' }),
    )
  })

  it('disables insert with an explanation when no pane is reachable', () => {
    storeState.activePaneId = null
    panesData = { panes: [] }
    setRequest({ files: [file('a.txt')], preferredRootId: 'root-workspace', preferredPath: '' })
    render(React.createElement(UploadConfirmDialog))
    expect(insertCheckbox().disabled).toBe(true)
    expect(screen.getByText('upload.insertNoPane')).toBeInTheDocument()
  })

  it('accepts arbitrary file types and shows ext·mime per row (unknown → octet-stream)', async () => {
    const files = [
      new File(['zip'], 'pack.zip', { type: 'application/zip' }),
      new File(['7z'], 'pack.7z', { type: 'application/x-7z-compressed' }),
      new File(['%pdf'], 'doc.pdf', { type: 'application/pdf' }),
      new File(['bin'], 'weights.gguf', { type: '' }), // 浏览器报不出类型
      new File(['x'], 'noext', { type: '' }), // 无扩展名且无 MIME
    ]
    setRequest({ files, preferredRootId: 'root-workspace', preferredPath: '' })
    render(React.createElement(UploadConfirmDialog))
    expect(screen.getByText('zip · application/zip')).toBeInTheDocument()
    expect(screen.getByText('7z · application/x-7z-compressed')).toBeInTheDocument()
    expect(screen.getByText('pdf · application/pdf')).toBeInTheDocument()
    expect(screen.getByText('gguf · application/octet-stream')).toBeInTheDocument()
    expect(screen.getByText('application/octet-stream · uploadTab.noExt')).toBeInTheDocument()
    // 未知类型不阻止提交
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    await waitFor(() => expect(api.files.upload).toHaveBeenCalledTimes(1))
    expect((vi.mocked(api.files.upload).mock.calls[0][1] as FormData).getAll('files')).toHaveLength(5)
  })

  it('blocks an oversized file with a clear message before hitting the server', () => {
    const big = new File(['x'], 'model.bin', { type: 'application/octet-stream' })
    Object.defineProperty(big, 'size', { value: 200 * 1024 * 1024 + 1 })
    setRequest({ files: [big], preferredRootId: 'root-workspace', preferredPath: '' })
    render(React.createElement(UploadConfirmDialog))
    expect(screen.getByText(/upload\.fileTooLarge/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'upload.upload' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'upload.upload' }))
    expect(api.files.upload).not.toHaveBeenCalled()
  })

  it('blocks batches over the per-request file count', () => {
    setRequest({
      files: Array.from({ length: 21 }, (_, i) => file(`f${i}.bin`)),
      preferredRootId: 'root-workspace',
      preferredPath: '',
    })
    render(React.createElement(UploadConfirmDialog))
    expect(screen.getByText(/upload\.tooMany/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'upload.upload' })).toBeDisabled()
    expect(api.files.upload).not.toHaveBeenCalled()
  })
})
