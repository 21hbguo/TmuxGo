import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorWorkbench } from './EditorWorkbench'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => React.createElement('textarea', { 'aria-label': 'editor', value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value) }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { theme: 'dark', fontFamily: 'monospace', fontSize: 14 } }),
}))

describe('EditorWorkbench', () => {
  beforeEach(() => {
    useConsoleStore.setState({
      openEditors: [{
        id: 'editor-1',
        rootId: 'root-workspace',
        rootLabel: 'Workspace',
        rootPath: '/workspace',
        path: 'src/index.ts',
        name: 'index.ts',
        absolutePath: '/workspace/src/index.ts',
        language: 'typescript',
        content: 'const value=1',
        savedContent: 'const value=1',
        modifiedAt: '2026-05-29T00:00:00.000Z',
        size: 13,
        dirty: false,
        loading: false,
        saving: false,
        binary: false,
        truncated: false,
      }],
      activeEditorId: 'editor-1',
    } as any)
  })

  it('closes the active editor on ctrl+w', () => {
    render(React.createElement(EditorWorkbench, { onSaveEditor: vi.fn(async () => {}) }))
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(useConsoleStore.getState().openEditors).toHaveLength(0)
    expect(screen.queryByText('/workspace/src/index.ts')).not.toBeInTheDocument()
  })
})
