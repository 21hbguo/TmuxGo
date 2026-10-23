import { SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'

// xterm 的 addon 实例只能由加载方持有：Terminal 没有公开的 addon 查询接口。
// 旧 TerminalSearch 靠穿 _addonManager 私有结构「猜」一个带 findNext 的实例，
// 而仓库当时根本没装 addon-search，那条搜索是永远静默失败的假实现。这里在
// loadAddon 处登记，组件按 terminal 实例查回，全程公开 API。
const registry = new WeakMap<Terminal, SearchAddon>()

// 装饰色只能用 #RRGGBB：addon 把颜色透传给 xterm 的 registerDecoration，不认 CSS 变量
export const SEARCH_DECORATIONS = {
  matchBackground: '#6b5a1c',
  matchBorder: '#c9a227',
  matchOverviewRuler: '#c9a227',
  activeMatchBackground: '#27506e',
  activeMatchBorder: '#5cc8ff',
  activeMatchColorOverviewRuler: '#5cc8ff',
}
// 高亮上限：单屏几百个命中已经看不清，再多只会拖慢渲染
export const SEARCH_HIGHLIGHT_LIMIT = 500

export function registerSearchAddon(terminal: Terminal, addon: SearchAddon) {
  registry.set(terminal, addon)
}

export function getSearchAddon(terminal: Terminal | null | undefined): SearchAddon | null {
  if (!terminal) return null
  return registry.get(terminal) ?? null
}

// clearDecorations 只清高亮装饰与结果集，选中区仍留在屏上；两者一起清才是
// 「关掉搜索后终端恢复原样」的语义
export function clearSearchHighlight(terminal: Terminal | null | undefined) {
  getSearchAddon(terminal)?.clearDecorations()
  terminal?.clearSelection()
}

export function createSearchAddon(terminal: Terminal): SearchAddon {
  const addon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
  terminal.loadAddon(addon)
  registerSearchAddon(terminal, addon)
  return addon
}

// 终端初始化不允许因为搜索失败而整体失败：addon 在 activate 里订阅 onWriteParsed/
// onResize（画布重排时重建高亮缓存），任何一处 API 缺失都会抛错，此时降级为无搜索
// 而不是白屏。返回 null 表示这台终端搜不了。
export function tryCreateSearchAddon(terminal: Terminal): SearchAddon | null {
  try {
    return createSearchAddon(terminal)
  } catch (error) {
    console.warn('terminal search unavailable', error)
    return null
  }
}
