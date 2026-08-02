import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadConfirmDialog } from './UploadConfirmDialog'
const storeState = vi.hoisted(() => ({
  uploadRequest: null as { files: File[]; insertPaths?: boolean; temporary?: boolean } | null,
  activePaneId: 'local:%1',
  activeHostId: 'local',
  closeUploadDialog: vi.fn(),
  pushToast: vi.fn(),
  addUploadJob: vi.fn(),
  updateUploadJob: vi.fn(),
}))
const apiMocks = vi.hoisted(() => ({
  temporaryUploadTarget: vi.fn(async () => ({ rootId: 'app-tmp', rootLabel: 'tmp', rootPath: '/tmp/tmuxgo-paste', path: '', absolutePath: '/tmp/tmuxgo-paste', source: 'temporary' })),
  defaultUploadTarget: vi.fn(async () => ({ rootId: 'root-workspace', rootLabel: 'workspace', rootPath: '/workspace', path: '', absolutePath: '/workspace', source: 'pane' })),
  upload: vi.fn(),
}))
const tMock = vi.hoisted(() => vi.fn((key: string, vars?: Record<string, unknown>) => vars?.count ? `${key}:${vars.count}` : key))
vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: any) => selector(storeState),
}))
vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: [{ id: 'root-workspace', label: 'workspace', path: '/workspace' }] }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { uploadRateLimitKBps: 200 } }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: tMock }),
}))
vi.mock('@/lib/api', () => ({
  api: { files: { temporaryUploadTarget: apiMocks.temporaryUploadTarget, defaultUploadTarget: apiMocks.defaultUploadTarget, upload: apiMocks.upload } },
}))
describe('UploadConfirmDialog', () => {
  beforeEach(() => {
    storeState.uploadRequest = { files: [new File(['png'], 'pasted.png', { type: 'image/png' })], insertPaths: true, temporary: true }
    storeState.closeUploadDialog.mockClear()
    storeState.pushToast.mockClear()
    storeState.addUploadJob.mockClear()
    storeState.updateUploadJob.mockClear()
    apiMocks.temporaryUploadTarget.mockClear()
    apiMocks.defaultUploadTarget.mockClear()
    apiMocks.upload.mockClear()
    tMock.mockClear()
  })
  it('uses the temporary upload target for pasted images', async () => {
    render(<UploadConfirmDialog />)
    await waitFor(() => expect(apiMocks.temporaryUploadTarget).toHaveBeenCalledWith('local'))
    expect(apiMocks.defaultUploadTarget).not.toHaveBeenCalled()
    expect(await screen.findByText('/tmp/tmuxgo-paste')).toBeInTheDocument()
  })
  it('uses a background task when terminal path insertion is disabled', async () => {
    apiMocks.upload.mockResolvedValueOnce({ task: { id: 'upload-1', type: 'file-upload', status: 'running' } })
    render(<UploadConfirmDialog />)
    await screen.findByText('/tmp/tmuxgo-paste')
    await screen.getByRole('checkbox').click()
    await screen.getByText('upload.upload').click()
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalled())
    const body = apiMocks.upload.mock.calls[0][1] as FormData
    expect(body.get('background')).toBe('true')
    expect(storeState.updateUploadJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'success' }))
  })
})
