// 移动端紧凑底栏的可调配项：localStorage 持久化（key 有序数组），
// 默认 [] = 全部收进「更多」即现状；设置页编辑后经事件同步到底栏
export const NAV_BAR_ITEMS_KEY = 'tmuxgo-mobile-nav-bar-items'
export const NAV_BAR_ITEMS_EVENT = 'tmuxgo-nav-bar-items-changed'

export const NAV_BAR_ITEM_KEYS = ['inbox', 'upload', 'files', 'git', 'desktop', 'settings'] as const
export type NavBarItemKey = (typeof NAV_BAR_ITEM_KEYS)[number]

// 非法/未知 key 静默剔除；输出恒按 NAV_BAR_ITEM_KEYS 固定序，栏位顺序不随点击顺序漂移
export function readNavBarItems(): NavBarItemKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NAV_BAR_ITEMS_KEY) || '[]')
    return Array.isArray(raw) ? NAV_BAR_ITEM_KEYS.filter((key) => raw.includes(key)) : []
  } catch {
    return []
  }
}

export function writeNavBarItems(keys: readonly string[]) {
  try {
    localStorage.setItem(NAV_BAR_ITEMS_KEY, JSON.stringify(NAV_BAR_ITEM_KEYS.filter((key) => keys.includes(key))))
  } catch {
    // 隐私模式等场景写不进：仅本次会话生效，仍派发事件让底栏即时刷新
  }
  window.dispatchEvent(new CustomEvent(NAV_BAR_ITEMS_EVENT))
}
