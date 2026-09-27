// 移动端紧凑底栏的可调配项：localStorage 持久化（key 有序数组），
// 默认 [] = 全部收进「更多」即现状；设置页编辑后经事件同步到底栏
export const NAV_BAR_ITEMS_KEY = 'tmuxgo-mobile-nav-bar-items'
export const NAV_BAR_ITEMS_EVENT = 'tmuxgo-nav-bar-items-changed'

export const NAV_BAR_ITEM_KEYS = ['inbox', 'upload', 'files', 'git', 'desktop', 'settings'] as const
export type NavBarItemKey = (typeof NAV_BAR_ITEM_KEYS)[number]

// 内存兜底：localStorage 写不进（隐私模式等）时同会话内仍保持一致
let cached: NavBarItemKey[] | null = null

// 非法/未知 key 静默剔除；输出恒按 NAV_BAR_ITEM_KEYS 固定序，栏位顺序不随点击顺序漂移
export function readNavBarItems(): NavBarItemKey[] {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(NAV_BAR_ITEMS_KEY) || '[]')
    return Array.isArray(raw) ? NAV_BAR_ITEM_KEYS.filter((key) => raw.includes(key)) : []
  } catch {
    return []
  }
}

export function writeNavBarItems(keys: readonly string[]) {
  cached = NAV_BAR_ITEM_KEYS.filter((key) => keys.includes(key))
  try {
    localStorage.setItem(NAV_BAR_ITEMS_KEY, JSON.stringify(cached))
  } catch {
    // 隐私模式等场景写不进：内存值已更新，本次会话仍生效
  }
  window.dispatchEvent(new CustomEvent(NAV_BAR_ITEMS_EVENT))
}
