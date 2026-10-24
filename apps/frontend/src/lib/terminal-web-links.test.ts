import { describe, expect, it, vi } from 'vitest'
import { WebLinksAddon, type ILinkProviderOptions } from '@xterm/addon-web-links'

// 真 addon 的行为契约（不 mock）：0.12 起 lockfile 里不再声明 @xterm/xterm peer，
// 说明它只依赖 Terminal 的结构（buffer/registerLinkProvider），不 import 运行时。
// 这层用例守住「升级后 URL 仍被识别、点击仍把 (event, uri) 交回我们自己的 handler」，
// 避免下次再升级时只靠 mock 用例假绿。
function fakeTerminal(text: string) {
  const line = {
    isWrapped: false,
    length: text.length,
    translateToString: () => text,
    getCell: (index: number, cell: { getChars: () => string; getWidth: () => number }) => {
      cell.getChars = () => text[index] ?? ''
      cell.getWidth = () => 1
      return cell
    },
  }
  const providers: Array<{ provideLinks: (y: number, cb: (links: unknown[]) => void) => void }> = []
  const terminal = {
    buffer: { active: { getLine: (y: number) => (y === 0 ? line : undefined), getNullCell: () => ({}) } },
    registerLinkProvider: (provider: (typeof providers)[number]) => {
      providers.push(provider)
      return { dispose: () => providers.splice(providers.indexOf(provider), 1) }
    },
  }
  const collect = () =>
    new Promise<Array<{ text: string; activate: (event: MouseEvent, uri: string) => void }>>((resolve) => {
      providers[0]!.provideLinks(1, (links) => resolve(links as never))
    })
  return { terminal, providers, collect }
}

describe('@xterm/addon-web-links real addon', () => {
  it('detects a URL in a buffer line and hands clicks to our handler', async () => {
    const handler = vi.fn()
    const { terminal, collect } = fakeTerminal('see https://example.com/docs#setup for details')
    const addon = new WebLinksAddon(handler)
    addon.activate(terminal as never)
    const links = await collect()

    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe('https://example.com/docs#setup')

    // 组件里靠 event.preventDefault/stopPropagation 阻止 xterm 自己开新窗口，必须拿到真事件对象
    const click = new MouseEvent('click', { cancelable: true, bubbles: true })
    links[0]!.activate(click, 'https://example.com/docs#setup')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![1]).toBe('https://example.com/docs#setup')
    expect(handler.mock.calls[0]![0]).toBe(click)
    expect(typeof handler.mock.calls[0]![0].preventDefault).toBe('function')
    addon.dispose()
  })

  it('honours a custom urlRegex from the options argument', async () => {
    // 我们自己不传 options，但 0.12 把它做成了公开 API，钉住签名代表 peer 缺失后类型仍对得上
    const options: ILinkProviderOptions = { urlRegex: /https:\/\/example\.com\S*/ }
    const { terminal, collect } = fakeTerminal('visit https://example.com/a and https://other.test/b')
    const addon = new WebLinksAddon(vi.fn(), options)
    addon.activate(terminal as never)
    const links = await collect()

    expect(links.map((link) => link.text)).toEqual(['https://example.com/a'])
    addon.dispose()
  })

  it('does not detect anything in plain text', async () => {
    const { terminal, collect } = fakeTerminal('no links here, just words')
    const addon = new WebLinksAddon(vi.fn())
    addon.activate(terminal as never)
    expect(await collect()).toEqual([])
    addon.dispose()
  })
})
