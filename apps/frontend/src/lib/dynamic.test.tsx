import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import dynamic from './dynamic'

function LoadedPanel() {
  return <div>panel-content</div>
}

type LoadResult = { default: ComponentType<any> }
function setupLoader() {
  const pending: { resolve: (m: LoadResult) => void; reject: (e: unknown) => void }[] = []
  // 每次 lazy() 新实例都会重新调用 loader：pending 记录每次 import 请求，重试后可区分
  const loader = vi.fn(
    () =>
      new Promise<LoadResult>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )
  return { loader, pending }
}

const CHUNK_RELOAD_FLAG = 'tmuxgo-chunk-reload'
const setOnline = (value: boolean) =>
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })

describe('dynamic lazy panel boundary', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    useConsoleStore.setState({ openEditors: [] } as any)
  })
  afterEach(() => {
    // 恢复 navigator.onLine 原型 getter（setOnline 用的是 own property 覆盖）
    delete (window.navigator as any).onLine
    useConsoleStore.setState({ openEditors: [] } as any)
  })

  it('shows a loading placeholder on first mount while the terminal stays mounted', async () => {
    const { loader, pending } = setupLoader()
    const Panel = dynamic(loader)
    render(
      <div>
        <div data-testid="terminal">term</div>
        <Panel />
      </div>,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
    // 同一挂载实例只发一次 chunk 请求（连点入口不会产生多个等待实例）
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => pending[0].resolve({ default: LoadedPanel }))
    expect(screen.getByText('panel-content')).toBeInTheDocument()
  })

  it('shows an in-panel error and retry re-issues the chunk request', async () => {
    const { loader, pending } = setupLoader()
    const Panel = dynamic(loader)
    render(
      <div>
        <div data-testid="terminal">term</div>
        <Panel />
      </div>,
    )
    await act(async () => pending[0].reject(new Error('boom')))
    expect(screen.getByText('common.loadFailed')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /common\.retry/ }))
    // lazy 失败实例不可复用：重试必须走新 lazy → loader 再次调用
    expect(loader).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toBeInTheDocument()
    await act(async () => pending[1].resolve({ default: LoadedPanel }))
    expect(screen.getByText('panel-content')).toBeInTheDocument()
  })

  it('keeps the whole-page reload strategy for stale chunks when nothing is unsaved', async () => {
    const { loader, pending } = setupLoader()
    const Panel = dynamic(loader)
    render(<Panel />)
    await act(async () => pending[0].reject(new Error('Loading chunk 123 failed')))
    // 旧 chunk 失效 → 沿用整页刷新恢复策略（flag 置位即触发过一次 reload）
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1')
    window.sessionStorage.removeItem(CHUNK_RELOAD_FLAG)
  })

  it('does not auto-reload a stale chunk while edits are unsaved', async () => {
    useConsoleStore.setState({ openEditors: [{ id: 'e1', dirty: true }] } as any)
    const { loader, pending } = setupLoader()
    const Panel = dynamic(loader)
    render(<Panel />)
    await act(async () => pending[0].reject(new Error('Loading chunk 123 failed')))
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull()
    expect(screen.getByText('common.loadFailed')).toBeInTheDocument()
  })

  it('stays on in-panel retry when offline instead of reloading', async () => {
    setOnline(false)
    const { loader, pending } = setupLoader()
    const Panel = dynamic(loader)
    render(<Panel />)
    await act(async () => pending[0].reject(new Error('Failed to fetch dynamically imported module')))
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull()
    expect(screen.getByText('common.loadFailed')).toBeInTheDocument()
    // 网络恢复后重试仍能真正重新请求
    setOnline(true)
    fireEvent.click(screen.getByRole('button', { name: /common\.retry/ }))
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => pending[1].resolve({ default: LoadedPanel }))
    expect(screen.getByText('panel-content')).toBeInTheDocument()
  })
})
