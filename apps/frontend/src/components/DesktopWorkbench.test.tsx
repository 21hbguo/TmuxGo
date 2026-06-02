import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopWorkbench } from './DesktopWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'

const contentMock = vi.fn()
const previewMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
      preview: (...args: any[]) => previewMock(...args),
      imageUrl: vi.fn(() => '/api/files/image'),
      saveContent: vi.fn(),
    },
  },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./ActivityBar', () => ({
  ActivityBar: () => React.createElement('div', null, 'activity'),
}))
vi.mock('./FilePanel', () => ({
  FilePanel: () => React.createElement('div', null, 'files'),
}))
vi.mock('./GitPanel', () => ({
  GitPanel: () => React.createElement('div', null, 'git'),
}))
vi.mock('./SessionPanel', () => ({
  SessionPanel: () => React.createElement('div', null, 'sessions'),
}))
vi.mock('./SessionRail', () => ({
  SessionRail: () => React.createElement('div', null, 'rail'),
}))
vi.mock('./EditorWorkbench', () => ({
  EditorWorkbench: () => React.createElement('div', null, 'editor'),
}))
vi.mock('./TerminalDock', () => ({
  TerminalDock: () => React.createElement('div', null, 'terminal'),
}))

describe('DesktopWorkbench', () => {
  beforeEach(() => {
    contentMock.mockReset()
    previewMock.mockReset()
    useConsoleStore.setState({
      activeHostId: 'local',
      sessionPanelExpanded: true,
      sessionPanelWidth: 248,
      filePanelWidth: 240,
      filePanelOpen: false,
      gitPanelOpen: false,
      gitPanelWidth: 320,
      terminalPanelHeight: 300,
      openEditors: [{
        id: 'local:root-workspace:src/index.ts',
        hostId: 'local',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/index.ts',
        name: 'index.ts',
        absolutePath: '/workspace/src/index.ts',
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
      }],
      activeEditorId: 'local:root-workspace:src/index.ts',
      editorsHydrated: true,
    } as any)
  })

  it('reloads content when reopening an existing empty editor', async () => {
    contentMock.mockResolvedValue({
      path: 'src/index.ts',
      type: 'file',
      size: 12,
      modifiedAt: '2026-06-02T00:00:00.000Z',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: 'const value=1',
    })
    render(React.createElement(DesktopWorkbench))
    await waitFor(() => expect(contentMock).toHaveBeenCalledWith('local', 'root-workspace', 'src/index.ts'))
    await waitFor(() => expect(useConsoleStore.getState().openEditors[0]).toMatchObject({
      content: 'const value=1',
      savedContent: 'const value=1',
      size: 12,
      loading: false,
      modifiedAt: '2026-06-02T00:00:00.000Z',
    }))
  })
})
