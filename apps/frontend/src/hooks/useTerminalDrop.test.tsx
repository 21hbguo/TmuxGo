import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalDrop } from './useTerminalDrop'
const formatDroppedPathsMock=vi.fn()
const readDraggedFileMock=vi.fn()
vi.mock('@/lib/path-drop', async () => {
  const actual=await vi.importActual<typeof import('@/lib/path-drop')>('@/lib/path-drop')
  return { ...actual, formatDroppedPaths: (...args: any[]) => formatDroppedPathsMock(...args) }
})
vi.mock('@/lib/editor-drag', () => ({
  readDraggedFile: (...args: any[]) => readDraggedFileMock(...args),
}))
function createDragEvent(overrides: Partial<DragEvent & { dataTransfer: DataTransfer }> = {}) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    relatedTarget: null,
    dataTransfer: {
      files: [] as unknown as FileList,
      dropEffect: 'none',
    },
    ...overrides,
  } as DragEvent
}
describe('useTerminalDrop', () => {
  it('activates drop state on drag over and clears it when leaving container', () => {
    const onInput=vi.fn()
    const openUploadDialog=vi.fn()
    const { result }=renderHook(() => useTerminalDrop(onInput, openUploadDialog))
    const event=createDragEvent()
    act(() => result.current.handleDragOver(event))
    expect(result.current.isDropActive).toBe(true)
    expect(event.dataTransfer?.dropEffect).toBe('copy')
    const container=document.createElement('div')
    act(() => result.current.handleDragLeave(createDragEvent({ relatedTarget: document.createElement('span') }), container))
    expect(result.current.isDropActive).toBe(false)
  })
  it('keeps drop state when moving within the same container', () => {
    const { result }=renderHook(() => useTerminalDrop(vi.fn(), vi.fn()))
    const container=document.createElement('div')
    const child=document.createElement('span')
    container.appendChild(child)
    act(() => result.current.handleDragOver(createDragEvent()))
    act(() => result.current.handleDragLeave(createDragEvent({ relatedTarget: child }), container))
    expect(result.current.isDropActive).toBe(true)
  })
  it('opens upload dialog when files are dropped', () => {
    const onInput=vi.fn()
    const openUploadDialog=vi.fn()
    const file=new File(['data'], 'demo.txt', { type: 'text/plain' })
    const { result }=renderHook(() => useTerminalDrop(onInput, openUploadDialog))
    act(() => result.current.handleDrop(createDragEvent({ dataTransfer: { files: [file] } as unknown as DataTransfer })))
    expect(openUploadDialog).toHaveBeenCalledWith({ files: [file], insertPaths: true })
    expect(onInput).not.toHaveBeenCalled()
  })
  it('inserts quoted absolute path from dragged editor file', () => {
    readDraggedFileMock.mockReturnValueOnce({ absolutePath: "/tmp/a b's.txt" })
    const onInput=vi.fn()
    const { result }=renderHook(() => useTerminalDrop(onInput, vi.fn()))
    act(() => result.current.handleDrop(createDragEvent()))
    expect(onInput).toHaveBeenCalledWith("'/tmp/a b'\\''s.txt'")
  })
  it('falls back to formatted dropped paths', () => {
    formatDroppedPathsMock.mockReturnValueOnce("'/tmp/alpha' '/tmp/beta'")
    const onInput=vi.fn()
    const { result }=renderHook(() => useTerminalDrop(onInput, vi.fn()))
    act(() => result.current.handleDrop(createDragEvent()))
    expect(onInput).toHaveBeenCalledWith("'/tmp/alpha' '/tmp/beta'")
  })
})
