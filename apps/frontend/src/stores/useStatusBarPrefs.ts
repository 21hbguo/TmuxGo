import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '@/lib/persist-storage'

// 状态栏可隐藏项的开关集合；存「隐藏名单」而非可见名单，
// 新增项默认可见，旧版本持久化数据天然兼容
export const STATUSBAR_ITEMS = ['context', 'net', 'gpu', 'cpu', 'mem', 'disks', 'sync', 'pkt', 'conn'] as const
export type StatusBarItem = (typeof STATUSBAR_ITEMS)[number]

interface StatusBarPrefsState {
  hidden: StatusBarItem[]
  toggle: (key: StatusBarItem) => void
}

export const useStatusBarPrefs = create<StatusBarPrefsState>()(
  persist(
    (set) => ({
      hidden: [],
      toggle: (key) =>
        set((s) => ({
          hidden: s.hidden.includes(key) ? s.hidden.filter((k) => k !== key) : [...s.hidden, key],
        })),
    }),
    {
      name: 'tmuxgo-statusbar',
      storage: createJSONStorage(() => createDebouncedStorage(120)),
      // 只持久化 hidden；非法条目在历史版本数据中可能存在，merge 时过滤掉
      merge: (persisted, current) => ({
        ...current,
        hidden: Array.isArray((persisted as any)?.hidden)
          ? (persisted as any).hidden.filter((k: unknown) => (STATUSBAR_ITEMS as readonly string[]).includes(String(k)))
          : [],
      }),
    },
  ),
)
