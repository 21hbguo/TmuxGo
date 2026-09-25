import {
  DELETE_NEXT_CHAR_SEQUENCE,
  DELETE_NEXT_WORD_SEQUENCE,
  DELETE_PREV_WORD_SEQUENCE,
  UNIX_WORD_RUBOUT_SEQUENCE,
} from './terminal-keys'
import { isApplePlatform, isImeKeyEvent, isPasteShortcut } from './terminal-platform'
import { recordImeDebug } from './terminal-debug'
import { consumeRecentDragGuard } from './editor-drag'
interface TerminalKeyHandlerOptions {
  getSelectionText: () => string
  runCopySelection: (selection: string, a: boolean, b: boolean, after?: () => void) => void
  scheduleKeyboardPasteFallback: () => void
  sendInput: (data: string) => void
  startDeleteWordRepeat: () => void
  isDeleteWordRepeatActive: () => boolean
  focusTerminalInput: () => void
}
export function createTerminalKeyEventHandler(options: TerminalKeyHandlerOptions) {
  return (e: KeyboardEvent) => {
    recordImeDebug('custom-key-handler', {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      keyCode: e.keyCode,
      isComposing: e.isComposing,
    })
    if (isImeKeyEvent(e)) return true
    const isMac = isApplePlatform()
    const modKey = isMac ? e.ctrlKey || e.metaKey : e.ctrlKey
    const altMod = isMac ? e.altKey : e.altKey || e.metaKey
    if (modKey && !altMod && e.key.toLowerCase() === 'c') {
      const selection = options.getSelectionText()
      if (selection) {
        options.runCopySelection(selection, true, true, options.focusTerminalInput)
        return false
      }
      // 拖拽刚结束时到达的无选区 Ctrl+C 多半是取词工具(如有道)合成的,吞掉一次避免误清输入行
      if (consumeRecentDragGuard()) return false
      return true
    }
    if (isPasteShortcut(e)) {
      if (e.repeat) return false
      options.scheduleKeyboardPasteFallback()
      return false
    }
    const isPrevWordKey = (e.key === 'Backspace' || (e.code === 'Backspace' && !e.key)) && modKey && !altMod
    if (isPrevWordKey) {
      if (e.repeat || options.isDeleteWordRepeatActive()) return false
      e.preventDefault()
      options.sendInput(DELETE_PREV_WORD_SEQUENCE)
      options.startDeleteWordRepeat()
      return false
    }
    const isPrevWordRubout = (e.key === 'Backspace' || (e.code === 'Backspace' && !e.key)) && altMod && !modKey
    if (isPrevWordRubout) {
      e.preventDefault()
      options.sendInput(UNIX_WORD_RUBOUT_SEQUENCE)
      return false
    }
    const isNextWordKey = (e.key === 'Delete' || (e.code === 'Delete' && !e.key)) && modKey && !altMod
    if (isNextWordKey) {
      e.preventDefault()
      options.sendInput(DELETE_NEXT_WORD_SEQUENCE)
      return false
    }
    const isNextWordAlt = (e.key === 'Delete' || (e.code === 'Delete' && !e.key)) && altMod && !modKey
    if (isNextWordAlt) {
      e.preventDefault()
      options.sendInput(DELETE_NEXT_WORD_SEQUENCE)
      return false
    }
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      options.sendInput(DELETE_NEXT_CHAR_SEQUENCE)
      return false
    }
    return true
  }
}
