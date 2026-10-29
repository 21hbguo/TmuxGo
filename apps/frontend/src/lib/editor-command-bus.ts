// 编辑器命令总线：工作台注册一个处理器，命令面板/全局快捷键把命令投进来。
// 之所以不引入全局状态库：命令是「行为」不是「状态」，bus 不需要持久化，
// 也不该让命令面板依赖 EditorWorkbench 的内部闭包（两者是兄弟组件）
import type { EditorCommandId } from './editor-commands'

type Handler = (command: EditorCommandId) => void

let handler: Handler | null = null
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((listener) => listener())

// 返回注销函数：工作台卸载（最后一个 tab 关闭）后命令面板立即失去编辑器命令
export function registerEditorCommandHandler(next: Handler | null) {
  handler = next
  notify()
  return () => {
    if (handler === next) {
      handler = null
      notify()
    }
  }
}

export function dispatchEditorCommand(command: EditorCommandId): boolean {
  if (!handler) return false
  handler(command)
  return true
}

export function isEditorCommandAvailable() {
  return handler !== null
}

export function subscribeEditorCommandAvailability(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetEditorCommandBus() {
  handler = null
  notify()
}
