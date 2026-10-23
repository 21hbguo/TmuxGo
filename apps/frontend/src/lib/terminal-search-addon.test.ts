import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  SEARCH_DECORATIONS,
  clearSearchHighlight,
  createSearchAddon,
  getSearchAddon,
  registerSearchAddon,
} from './terminal-search-addon'
import type { SearchAddon } from '@xterm/addon-search'

// 真实 xterm + 真实 addon：这条用例的存在意义就是防止再出现「组件里调了一个不存在的
// addon、搜索静默失效」。jsdom 没有 matchMedia，xterm 的 DOM renderer 需要它。
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

async function createTerminalWithText() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true })
  const addon = createSearchAddon(terminal)
  terminal.open(host)
  await new Promise<void>((resolve) => terminal.write('alpha beta\r\nfoo bar\r\nfoo baz\r\ngamma foo\r\n', resolve))
  return { terminal, addon }
}

describe('terminal-search-addon', () => {
  it('registers the addon it loads so components can look it up by terminal instance', () => {
    const host = document.createElement('div')
    const terminal = new Terminal({ cols: 80, rows: 10 })
    const addon = createSearchAddon(terminal)
    expect(getSearchAddon(terminal)).toBe(addon)
    expect(getSearchAddon(null)).toBeNull()
    // 未注册的终端不得拿到别人的 addon
    const other = new Terminal({ cols: 80, rows: 10 })
    expect(getSearchAddon(other)).toBeNull()
    registerSearchAddon(other, addon as SearchAddon)
    expect(getSearchAddon(other)).toBe(addon)
    host.remove()
  })

  it('finds, highlights and navigates matches through the public addon API', async () => {
    const { terminal, addon } = await createTerminalWithText()
    const events: { resultIndex: number; resultCount: number }[] = []
    addon.onDidChangeResults((event) => events.push(event))

    // 高亮装饰只在传 decorations 时才注册，也是 onDidChangeResults 的触发条件
    const decorationSpy = vi.spyOn(terminal, 'registerDecoration')
    const options = { decorations: SEARCH_DECORATIONS, incremental: true }
    expect(addon.findNext('foo', options)).toBe(true)
    expect(terminal.getSelection()).toBe('foo')
    expect(decorationSpy).toHaveBeenCalled()
    // 命中总数 3（foo bar / foo baz / gamma foo），首个命中下标 0
    expect(events.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 })

    addon.findNext('foo', options)
    expect(events.at(-1)).toEqual({ resultIndex: 1, resultCount: 3 })
    addon.findPrevious('foo', options)
    expect(events.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 })

    // 大小写/正则都走 addon 原生选项，不做二次实现
    expect(addon.findNext('FOO', { ...options, caseSensitive: true })).toBe(false)
    expect(addon.findNext('FOO', { ...options, caseSensitive: false })).toBe(true)
    expect(terminal.getSelection()).toBe('foo')
    expect(addon.findNext('b.r', { ...options, regex: true })).toBe(true)
    expect(terminal.getSelection()).toBe('bar')

    // clearDecorations 单独用只会清装饰，选中区还在；clearSearchHighlight 两者都清
    addon.clearDecorations()
    expect(terminal.getSelection()).toBe('bar')
    clearSearchHighlight(terminal)
    expect(terminal.getSelection()).toBe('')
    terminal.dispose()
  })
})
