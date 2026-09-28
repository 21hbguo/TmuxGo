import { create } from 'zustand'
import { describeElement, resolvePickTarget, type PickedElementInfo } from '@/lib/element-picker'

interface ElementPickerState {
  active: boolean
  selected: PickedElementInfo | null
  start: () => void
  stop: () => void
  toggle: () => void
  // 入参是原始命中目标：store 内部做规整（拾取器 UI/xterm 内部/非元素命中会先行归一）
  selectElement: (el: EventTarget | null) => void
  clearSelection: () => void
}

export const useElementPickerStore = create<ElementPickerState>()((set, get) => ({
  active: false,
  selected: null,
  start: () => set({ active: true, selected: null }),
  stop: () => set({ active: false, selected: null }),
  toggle: () => (get().active ? get().stop() : get().start()),
  selectElement: (el) => {
    const target = resolvePickTarget(el)
    if (target) set({ selected: describeElement(target) })
  },
  clearSelection: () => set({ selected: null }),
}))
