import { describe, expect, it, vi } from 'vitest'

// 查询 generation：过期响应不得 setState
function createSearchRunner() {
  let generation = 0
  let state: unknown[] = []
  const run = async (query: string, fetcher: (q: string, signal: AbortSignal) => Promise<unknown[]>) => {
    const gen = ++generation
    const ac = new AbortController()
    try {
      const result = await fetcher(query, ac.signal)
      if (gen !== generation) return { applied: false, state }
      state = result
      return { applied: true, state }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return { applied: false, state }
      throw e
    }
  }
  return {
    run,
    getState: () => state,
    cancel: () => {
      generation += 1
    },
  }
}

describe('file search cancel / generation', () => {
  it('drops stale response after generation bump (no setState)', async () => {
    const runner = createSearchRunner()
    let releaseOld!: (v: unknown[]) => void
    const oldPromise = new Promise<unknown[]>((r) => {
      releaseOld = r
    })
    const p1 = runner.run('old', () => oldPromise)
    runner.cancel() // 取消/新查询
    releaseOld([{ id: 1 }])
    const r1 = await p1
    expect(r1.applied).toBe(false)
    expect(runner.getState()).toEqual([])
    // 新查询正常应用
    const r2 = await runner.run('new', async () => [{ id: 2 }])
    expect(r2.applied).toBe(true)
    expect(runner.getState()).toEqual([{ id: 2 }])
  })

  it('AbortError never applies state', async () => {
    const runner = createSearchRunner()
    const r = await runner.run('x', async (_q, signal) => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      signal.throwIfAborted?.()
      throw err
    })
    expect(r.applied).toBe(false)
    expect(runner.getState()).toEqual([])
  })
})
