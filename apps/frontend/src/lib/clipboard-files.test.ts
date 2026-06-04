import { describe, expect, it, vi } from 'vitest'
import { extractClipboardImageFiles } from './clipboard-files'
function createClipboardData(files: File[]) {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
  } as unknown as DataTransfer
}
describe('extractClipboardImageFiles', () => {
  it('converts pasted images to timestamped files', () => {
    vi.setSystemTime(new Date('2026-06-04T08:09:10.000Z'))
    const file=new File(['image-bytes'], 'image.png', { type: 'image/png' })
    const result=extractClipboardImageFiles(createClipboardData([file]))
    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(File)
    expect(result[0].name).toBe('pasted-20260604-080910.png')
    expect(result[0].type).toBe('image/png')
    expect(result[0].size).toBe(file.size)
    vi.useRealTimers()
  })
  it('ignores non-image clipboard files', () => {
    const textFile=new File(['text'], 'note.txt', { type: 'text/plain' })
    expect(extractClipboardImageFiles(createClipboardData([textFile]))).toEqual([])
  })
})
