import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalFilePicker } from './GlobalFilePicker'

const openUploadDialog = vi.fn()
const setStagedUploadFiles = vi.fn()
const pickerStore: any = { stagedUploadFiles: [] as File[] }

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: Object.assign((selector: any) => selector({}), {
    getState: () => ({ ...pickerStore, openUploadDialog, setStagedUploadFiles }),
  }),
}))

describe('GlobalFilePicker', () => {
  beforeEach(() => {
    openUploadDialog.mockReset()
    setStagedUploadFiles.mockReset()
    pickerStore.stagedUploadFiles = []
  })

  it('keeps the input rendered (not display:none) so programmatic click reaches mobile pickers', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.className).toContain('sr-only')
    expect(input.className).not.toContain('hidden')
    expect(input.hasAttribute('webkitdirectory')).toBe(false)
    expect(input.hasAttribute('capture')).toBe(false)
    expect(input.hasAttribute('accept')).toBe(false)
    expect(input.multiple).toBe(true)
  })

  it('responds to tmuxgo-pick-upload-files by clicking the input synchronously', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')
    fireEvent(window, new CustomEvent('tmuxgo-pick-upload-files', { detail: { rootId: 'r1', path: 'src' } }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('routes picked files + context into openUploadDialog', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent(
      window,
      new CustomEvent('tmuxgo-pick-upload-files', {
        detail: { hostId: 'host-b', rootId: 'root-workspace', path: 'src/nested' },
      }),
    )
    const file = new File(['hello'], 'demo.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(openUploadDialog).toHaveBeenCalledTimes(1)
    const request = openUploadDialog.mock.calls[0][0]
    expect(request.files).toHaveLength(1)
    expect(request.files[0].name).toBe('demo.txt')
    expect(request.hostId).toBe('host-b')
    expect(request.preferredRootId).toBe('root-workspace')
    expect(request.preferredPath).toBe('src/nested')
    expect(request.insertPaths).toBeUndefined()
  })

  it('resets input value so re-picking the same file fires change again', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent(window, new CustomEvent('tmuxgo-pick-upload-files', { detail: {} }))
    const file = new File(['x'], 'same.bin')
    fireEvent.change(input, { target: { files: [file] } })
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { files: [file] } })
    expect(openUploadDialog).toHaveBeenCalledTimes(2)
  })

  it('stage mode appends picks to the global staged list instead of opening the dialog', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    pickerStore.stagedUploadFiles = [new File(['a'], 'old.txt')]
    fireEvent(window, new CustomEvent('tmuxgo-pick-upload-files', { detail: { stage: true } }))
    fireEvent.change(input, { target: { files: [new File(['bb'], 'new.txt')] } })
    expect(openUploadDialog).not.toHaveBeenCalled()
    expect(setStagedUploadFiles).toHaveBeenCalledTimes(1)
    const next = setStagedUploadFiles.mock.calls[0][0]
    expect(next.map((f: File) => f.name)).toEqual(['old.txt', 'new.txt'])
  })

  it('ignores empty selections (picker cancelled)', () => {
    render(React.createElement(GlobalFilePicker))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent(window, new CustomEvent('tmuxgo-pick-upload-files', { detail: {} }))
    fireEvent.change(input, { target: { files: [] } })
    expect(openUploadDialog).not.toHaveBeenCalled()
  })
})
