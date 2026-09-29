import { create } from 'zustand'

// 终端拖选实时字符数（跟手浮层数据源）。xterm=浏览器侧选区（Shift+拖选），
// tmux=copy-mode 选区（mouse on 时普通拖选被 tmux 接管，坐标经 gateway 轮询）
export interface TerminalDragSelection {
  chars: number
  x: number
  y: number
  source: 'xterm' | 'tmux'
}

interface TerminalSelectionState {
  dragSelection: TerminalDragSelection | null
  setDragSelection: (info: TerminalDragSelection | null) => void
}

export const useTerminalSelectionStore = create<TerminalSelectionState>((set) => ({
  dragSelection: null,
  setDragSelection: (info) => set({ dragSelection: info }),
}))
