// 编辑区命令表 + 键位解析（含 Ctrl+K 和弦）。
// 命令表是「一个事实源」：工具栏提示、命令面板条目、快捷键说明页、键盘处理器都读它，
// 避免同一个动作在四个地方各写一份标题和键位。
import type { TranslationKey } from '@/i18n'

export type EditorCommandId =
  | 'goto-line'
  | 'goto-symbol'
  | 'goto-definition'
  | 'navigate-back'
  | 'navigate-forward'
  | 'toggle-word-wrap'
  | 'toggle-minimap'
  | 'toggle-whitespace'
  | 'toggle-sticky-scroll'
  | 'toggle-breadcrumbs'
  | 'toggle-status-bar'
  | 'toggle-auto-save'
  | 'toggle-markdown-live'
  | 'format-document'
  | 'find'
  | 'replace'
  | 'save'
  | 'save-all'
  | 'close'
  | 'close-all'
  | 'reopen-closed'
  | 'split-right'
  | 'split-down'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'select-next-occurrence'
  | 'select-all-occurrences'
  | 'add-cursor-above'
  | 'add-cursor-below'
  | 'next-editor'
  | 'previous-editor'
  | 'copy-path'
  | 'copy-relative-path'
  | 'reveal-in-files'
  | 'keep-open'
  | 'close-others'
  | 'close-to-right'
  | 'close-saved'
  | 'show-shortcuts'

export type EditorCommandGroup = 'navigation' | 'view' | 'tabs' | 'edit'

export interface EditorCommandDef {
  id: EditorCommandId
  titleKey: TranslationKey
  keywords: string[]
  group: EditorCommandGroup
  // 'Mod' 在展示时按平台替换成 Cmd/Ctrl；和弦用空格分隔两段
  keybinding?: string
  // 需要活动编辑器实例（只读/比较视图下不可用）
  requiresEditor?: boolean
}

export const EDITOR_COMMANDS: EditorCommandDef[] = [
  {
    id: 'goto-line',
    group: 'navigation',
    titleKey: 'editor.cmd.gotoLine',
    keywords: ['line', 'jump', '行号', '跳行'],
    keybinding: 'Mod+G',
  },
  {
    id: 'goto-symbol',
    group: 'navigation',
    titleKey: 'editor.cmd.gotoSymbol',
    keywords: ['symbol', 'outline', '符号', '大纲'],
    keybinding: 'Mod+Shift+O',
  },
  {
    id: 'goto-definition',
    group: 'navigation',
    titleKey: 'editor.cmd.gotoDefinition',
    keywords: ['definition', '定义', '跳转'],
    keybinding: 'F12',
    requiresEditor: true,
  },
  {
    id: 'navigate-back',
    group: 'navigation',
    titleKey: 'editor.cmd.navigateBack',
    keywords: ['back', '返回', '后退'],
    keybinding: 'Alt+Left',
  },
  {
    id: 'navigate-forward',
    group: 'navigation',
    titleKey: 'editor.cmd.navigateForward',
    keywords: ['forward', '前进'],
    keybinding: 'Alt+Right',
  },
  {
    id: 'toggle-word-wrap',
    group: 'view',
    titleKey: 'editor.cmd.toggleWordWrap',
    keywords: ['wrap', '换行', '自动换行'],
    keybinding: 'Alt+Z',
  },
  { id: 'toggle-minimap', group: 'view', titleKey: 'editor.cmd.toggleMinimap', keywords: ['minimap', '缩略图'] },
  {
    id: 'toggle-whitespace',
    group: 'view',
    titleKey: 'editor.cmd.toggleWhitespace',
    keywords: ['whitespace', '空白', '渲染空白'],
  },
  {
    id: 'toggle-sticky-scroll',
    group: 'view',
    titleKey: 'editor.cmd.toggleStickyScroll',
    keywords: ['sticky', '粘性', '吸顶'],
  },
  {
    id: 'toggle-breadcrumbs',
    group: 'view',
    titleKey: 'editor.cmd.toggleBreadcrumbs',
    keywords: ['breadcrumb', '面包屑', '路径'],
  },
  { id: 'toggle-status-bar', group: 'view', titleKey: 'editor.cmd.toggleStatusBar', keywords: ['status', '状态栏'] },
  { id: 'toggle-auto-save', group: 'view', titleKey: 'editor.cmd.toggleAutoSave', keywords: ['autosave', '自动保存'] },
  {
    id: 'toggle-markdown-live',
    group: 'view',
    titleKey: 'editor.cmd.toggleMarkdownLive',
    keywords: ['markdown', 'live', 'preview', '实时预览', '源码'],
  },
  {
    id: 'format-document',
    group: 'edit',
    titleKey: 'editor.cmd.formatDocument',
    keywords: ['format', '格式化'],
    keybinding: 'Shift+Alt+F',
    requiresEditor: true,
  },
  {
    id: 'find',
    group: 'edit',
    titleKey: 'editor.cmd.find',
    keywords: ['find', '查找'],
    keybinding: 'Mod+F',
    requiresEditor: true,
  },
  {
    id: 'replace',
    group: 'edit',
    titleKey: 'editor.cmd.replace',
    keywords: ['replace', '替换'],
    keybinding: 'Mod+H',
    requiresEditor: true,
  },
  { id: 'save', group: 'tabs', titleKey: 'editor.cmd.save', keywords: ['save', '保存'], keybinding: 'Mod+S' },
  {
    id: 'save-all',
    group: 'tabs',
    titleKey: 'editor.cmd.saveAll',
    keywords: ['save all', '全部保存'],
    keybinding: 'Alt+K S',
  },
  { id: 'close', group: 'tabs', titleKey: 'editor.cmd.close', keywords: ['close', '关闭'], keybinding: 'Mod+W' },
  {
    id: 'close-all',
    group: 'tabs',
    titleKey: 'editor.cmd.closeAll',
    keywords: ['close all', '全部关闭'],
    keybinding: 'Alt+K W',
  },
  {
    id: 'reopen-closed',
    group: 'tabs',
    titleKey: 'editor.cmd.reopenClosed',
    keywords: ['reopen', '重开', '恢复关闭'],
    keybinding: 'Mod+Shift+T',
  },
  {
    id: 'split-right',
    group: 'tabs',
    titleKey: 'editor.cmd.splitRight',
    keywords: ['split', '分屏', '右侧'],
    keybinding: 'Mod+\\',
  },
  { id: 'split-down', group: 'tabs', titleKey: 'editor.cmd.splitDown', keywords: ['split down', '下方分屏'] },
  { id: 'zoom-in', group: 'view', titleKey: 'editor.cmd.zoomIn', keywords: ['zoom', '放大'], keybinding: 'Mod+=' },
  { id: 'zoom-out', group: 'view', titleKey: 'editor.cmd.zoomOut', keywords: ['zoom', '缩小'], keybinding: 'Mod+-' },
  {
    id: 'zoom-reset',
    group: 'view',
    titleKey: 'editor.cmd.zoomReset',
    keywords: ['zoom reset', '重置缩放'],
    keybinding: 'Mod+0',
  },
  {
    id: 'select-next-occurrence',
    group: 'edit',
    titleKey: 'editor.cmd.selectNextOccurrence',
    keywords: ['multi cursor', '多光标', '下一个匹配'],
    keybinding: 'Mod+D',
    requiresEditor: true,
  },
  {
    id: 'select-all-occurrences',
    group: 'edit',
    titleKey: 'editor.cmd.selectAllOccurrences',
    keywords: ['select highlights', '选中所有匹配'],
    requiresEditor: true,
  },
  {
    id: 'add-cursor-above',
    group: 'edit',
    titleKey: 'editor.cmd.addCursorAbove',
    keywords: ['cursor', '列光标', '上方'],
    keybinding: 'Mod+Alt+Up',
    requiresEditor: true,
  },
  {
    id: 'add-cursor-below',
    group: 'edit',
    titleKey: 'editor.cmd.addCursorBelow',
    keywords: ['cursor', '列光标', '下方'],
    keybinding: 'Mod+Alt+Down',
    requiresEditor: true,
  },
  {
    id: 'next-editor',
    group: 'navigation',
    titleKey: 'editor.cmd.nextEditor',
    keywords: ['next tab', '下一个'],
    keybinding: 'Mod+PageDown',
  },
  {
    id: 'previous-editor',
    group: 'navigation',
    titleKey: 'editor.cmd.previousEditor',
    keywords: ['previous tab', '上一个'],
    keybinding: 'Mod+PageUp',
  },
  { id: 'copy-path', group: 'tabs', titleKey: 'editor.cmd.copyPath', keywords: ['copy path', '复制路径'] },
  {
    id: 'copy-relative-path',
    group: 'tabs',
    titleKey: 'editor.cmd.copyRelativePath',
    keywords: ['relative', '相对路径'],
  },
  {
    id: 'reveal-in-files',
    group: 'tabs',
    titleKey: 'editor.cmd.revealInFiles',
    keywords: ['reveal', '文件区', '定位'],
  },
  { id: 'keep-open', group: 'tabs', titleKey: 'editor.cmd.keepOpen', keywords: ['pin', '钉住', '保持打开'] },
  { id: 'close-others', group: 'tabs', titleKey: 'editor.cmd.closeOthers', keywords: ['close others', '关闭其它'] },
  {
    id: 'close-to-right',
    group: 'tabs',
    titleKey: 'editor.cmd.closeToRight',
    keywords: ['close to the right', '关闭右侧'],
  },
  { id: 'close-saved', group: 'tabs', titleKey: 'editor.cmd.closeSaved', keywords: ['close saved', '关闭已保存'] },
  {
    id: 'show-shortcuts',
    group: 'view',
    titleKey: 'editor.cmd.showShortcuts',
    keywords: ['shortcuts', '快捷键'],
    keybinding: 'Mod+Shift+/',
  },
]

export const EDITOR_COMMANDS_BY_ID = new Map<EditorCommandId, EditorCommandDef>(
  EDITOR_COMMANDS.map((command) => [command.id, command]),
)

export function formatKeybinding(binding: string | undefined, isMac: boolean): string {
  if (!binding) return ''
  // 大小写不敏感：命令表写 'Mod+S'，和弦存 'mod+k'，两处都要渲染成平台键名
  return (
    binding
      .split('+')
      .map((token) =>
        token
          .replace(/\bmod\b/gi, isMac ? 'Cmd' : 'Ctrl')
          .replace(/\balt\b/gi, isMac ? 'Option' : 'Alt')
          .replace(/\bshift\b/gi, 'Shift')
          .replace(/\bctrl\b/gi, 'Ctrl'),
      )
      // 单字母键位显示成大写（k → K），词形键（Cmd/Ctrl/PageDown）原样
      .map((token) => (/^[a-z]$/.test(token) ? token.toUpperCase() : token))
      .join('+')
  )
}

export interface EditorKeyInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

// 和弦前缀用 Alt+K 而不是 VSCode 的 Ctrl+K：本仓 Ctrl+K 是命令面板（ConsoleLayout），
// 编辑器抢走会让面板在编辑态失效，冲突无法兼容
export type EditorChord = 'alt+k'

export type EditorKeyResolution =
  | { type: 'command'; id: EditorCommandId }
  | { type: 'chord'; chord: EditorChord }
  | { type: 'focus-group'; index: number }
  | null

export const CHORD_TIMEOUT_MS = 1500

// 键位解析是纯函数：keydown 处理器只负责「取事件字段 → 调这里 → 执行命令」。
// 注意顺序——和弦前缀必须先判，否则 Mod+K 会被当成普通组合键漏下去。
export function resolveEditorKey(input: EditorKeyInput, pendingChord: EditorChord | null): EditorKeyResolution {
  const mod = input.ctrlKey || input.metaKey
  // 字符键统一小写；命名键（ArrowLeft/F12/PageDown）本身就带大小写，也一并小写比对
  const key = input.key.toLowerCase()

  // 和弦进行中：第二个键仍带 Alt（浏览器/终端会把 Alt+K 的后续键也带上 Alt）
  if (pendingChord === 'alt+k') {
    if (!input.altKey) return null
    if (!input.shiftKey && key === 's') return { type: 'command', id: 'save-all' }
    if (!input.shiftKey && key === 'w') return { type: 'command', id: 'close-all' }
    return null
  }

  if (!mod && !input.altKey && key === 'f12') return { type: 'command', id: 'goto-definition' }
  if (!mod && !input.shiftKey && input.altKey && key === 'arrowleft') return { type: 'command', id: 'navigate-back' }
  if (!mod && !input.shiftKey && input.altKey && key === 'arrowright')
    return { type: 'command', id: 'navigate-forward' }
  if (!mod && !input.ctrlKey && input.altKey && !input.shiftKey && key === 'z')
    return { type: 'command', id: 'toggle-word-wrap' }
  if (!mod && input.altKey && input.shiftKey && key === 'f') return { type: 'command', id: 'format-document' }
  // 和弦前缀必须在 `if (!mod) return null` 之前判：Alt+K 不带 mod
  if (!mod && input.altKey && !input.shiftKey && key === 'k') return { type: 'chord', chord: 'alt+k' }

  if (!mod) return null

  // 编辑器内 Ctrl+1..9 切分组：只对单字符数字生效，避免影响 Ctrl+Shift+1 之类
  if (!input.shiftKey && !input.altKey && /^[1-9]$/.test(key)) return { type: 'focus-group', index: Number(key) - 1 }

  if (!input.shiftKey && !input.altKey && key === 'g') return { type: 'command', id: 'goto-line' }
  if (input.shiftKey && !input.altKey && key === 'o') return { type: 'command', id: 'goto-symbol' }
  if (input.shiftKey && !input.altKey && key === 't') return { type: 'command', id: 'reopen-closed' }
  // Shift+/ 在美式布局里 key 是 '?'，两种都认，否则 mac/中文输入法下打不开快捷键页
  if (input.shiftKey && !input.altKey && (key === '/' || key === '?')) return { type: 'command', id: 'show-shortcuts' }
  if (!input.shiftKey && !input.altKey && key === 'h') return { type: 'command', id: 'replace' }
  // 缩放要收 Shift：美式键盘上 Ctrl++ 实际是 Ctrl+Shift+=，只认 '=' 会导致按加号没反应
  if (!input.altKey && (key === '=' || key === '+')) return { type: 'command', id: 'zoom-in' }
  if (!input.altKey && (key === '-' || key === '_')) return { type: 'command', id: 'zoom-out' }
  if (!input.altKey && key === '0') return { type: 'command', id: 'zoom-reset' }
  if (!input.shiftKey && !input.altKey && key === '\\') return { type: 'command', id: 'split-right' }
  if (!input.shiftKey && !input.altKey && key === 's') return { type: 'command', id: 'save' }
  if (!input.shiftKey && !input.altKey && key === 'w') return { type: 'command', id: 'close' }
  if (!input.shiftKey && !input.altKey && key === 'pagedown') return { type: 'command', id: 'next-editor' }
  if (!input.shiftKey && !input.altKey && key === 'pageup') return { type: 'command', id: 'previous-editor' }
  return null
}

// Monaco 原生 action id 映射：能用内置 action 就不自己实现编辑器内部编辑逻辑
export const MONACO_ACTIONS: Record<string, string> = {
  find: 'actions.find',
  replace: 'editor.action.startFindReplaceAction',
  'format-document': 'editor.action.formatDocument',
  'select-next-occurrence': 'editor.action.addSelectionToNextFindMatch',
  'select-all-occurrences': 'editor.action.selectHighlights',
  'add-cursor-above': 'editor.action.insertCursorAbove',
  'add-cursor-below': 'editor.action.insertCursorBelow',
  'goto-symbol': 'editor.action.quickOutline',
}
