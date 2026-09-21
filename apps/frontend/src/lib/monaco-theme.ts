import type { Monaco } from '@monaco-editor/react'

type IStandaloneThemeData = Parameters<Monaco['editor']['defineTheme']>[1]

// CSS 变量是 '12 13 15' 三元组（配合 rgb(var(--x)) 用法），转成 Monaco 要的 #RRGGBB
export function rgbTripletToHex(raw: string) {
  const parts = raw.trim().split(/\s+/).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
  return `#${parts
    .slice(0, 3)
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

// --line 等变量是 rgba(...) 字面量，转 #RRGGBBAA；三元组走 rgbTripletToHex
export function cssColorToHex(raw: string) {
  const value = raw.trim()
  if (!value) return null
  const triplet = rgbTripletToHex(value)
  if (triplet) return triplet
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/)
  if (!match) return null
  const alpha =
    match[4] === undefined
      ? ''
      : Math.round(
          Math.max(0, Math.min(1, match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]))) * 255,
        )
          .toString(16)
          .padStart(2, '0')
  return `#${[match[1], match[2], match[3]]
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(parseFloat(n))))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}${alpha}`
}

export function monacoBaseTheme(theme: string): IStandaloneThemeData['base'] {
  if (theme === 'light') return 'vs'
  if (theme === 'high-contrast') return 'hc-black'
  return 'vs-dark'
}

export function tmuxgoThemeName(theme: string) {
  return `tmuxgo-${theme}`
}

function readVar(name: string, fallback: string) {
  const hex = cssColorToHex(getComputedStyle(document.documentElement).getPropertyValue(name))
  return hex ?? fallback
}

// 同名 defineTheme 会整体覆盖——主题切换时 CSS 变量已换，重定义即换色，无需卸载重建
export function ensureTmuxgoTheme(monaco: Monaco, theme: string) {
  const name = tmuxgoThemeName(theme)
  const bg0 = readVar('--bg-0', theme === 'light' ? '#e8eaee' : '#0c0d0f')
  const bg1 = readVar('--bg-1', theme === 'light' ? '#f8f9fb' : '#18191c')
  const text1 = readVar('--text-1', theme === 'light' ? '#1c1c1e' : '#f5f5f7')
  const text3 = readVar('--text-3', theme === 'light' ? '#5a5a5f' : '#96969b')
  const accent = readVar('--accent', '#0a84ff')
  const line = readVar('--line', theme === 'light' ? '#3c3c4329' : '#ffffff1a')
  monaco.editor.defineTheme(name, {
    base: monacoBaseTheme(theme),
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg0,
      'editorGutter.background': bg0,
      'minimap.background': bg0,
      'editor.foreground': text1,
      'editor.lineHighlightBackground': bg1,
      'editorLineNumber.foreground': text3,
      'editorLineNumber.activeForeground': text1,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': `${accent}38`,
      'editor.inactiveSelectionBackground': `${accent}1f`,
      'editorWidget.background': bg1,
      'editorWidget.border': line,
      'editorSuggestWidget.background': bg1,
      'editorSuggestWidget.border': line,
      'editorHoverWidget.background': bg1,
      'editorHoverWidget.border': line,
      // 与 .tmuxgo-scrollbar-subtle 统一：常态 text-3 细灰条，悬停/拖拽转 accent
      'scrollbarSlider.background': `${text3}66`,
      'scrollbarSlider.hoverBackground': `${accent}8c`,
      'scrollbarSlider.activeBackground': `${accent}cc`,
    },
  })
  return name
}
