import { describe, expect, it, vi } from 'vitest'
import { recoverFromChunkLoadError } from './chunk-recovery'
describe('chunk-recovery', () => {
  it('reloads once for chunk load failures', () => {
    const storage=new Map<string,string>()
    const reload=vi.fn()
    expect(recoverFromChunkLoadError('Loading chunk 931 failed.',{
      getItem:(key)=>storage.get(key)??null,
      setItem:(key,value)=>void storage.set(key,value),
      removeItem:(key)=>void storage.delete(key),
    },reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.size).toBe(1)
    expect(recoverFromChunkLoadError('Loading chunk 931 failed.',{
      getItem:(key)=>storage.get(key)??null,
      setItem:(key,value)=>void storage.set(key,value),
      removeItem:(key)=>void storage.delete(key),
    },reload)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('ignores non chunk errors and clears stale flag', () => {
    const storage=new Map<string,string>([['tmuxgo-chunk-reload','1']])
    const reload=vi.fn()
    expect(recoverFromChunkLoadError('render failed',{
      getItem:(key)=>storage.get(key)??null,
      setItem:(key,value)=>void storage.set(key,value),
      removeItem:(key)=>void storage.delete(key),
    },reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(storage.has('tmuxgo-chunk-reload')).toBe(false)
  })
})
