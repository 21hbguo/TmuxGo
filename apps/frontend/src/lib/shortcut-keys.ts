// 自定义快捷键的「按键记法 + 终端编码」单一事实源。
// 录制、宏执行、导入导出都走这里，改口径只改这一处。

const KEY_MAP: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  space: ' ',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  insert: '\x1b[2~',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
}

// Shift 只有方向/编辑键有独立序列（CSI 1;2X）；功能键没有 Shift 变体，按原键发
const SHIFT_KEY_MAP: Record<string, string> = {
  up: '\x1b[1;2A',
  down: '\x1b[1;2B',
  right: '\x1b[1;2C',
  left: '\x1b[1;2D',
  home: '\x1b[1;2H',
  end: '\x1b[1;2F',
  insert: '\x1b[2;2~',
  delete: '\x1b[3;2~',
  pageup: '\x1b[5;2~',
  pagedown: '\x1b[6;2~',
}
// Ctrl+符号的 ASCII 控制位（@ _ 等），其余符号无标准编码
const CTRL_SYMBOL_MAP: Record<string, string> = {
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f',
}

/** 规范里的修饰符顺序：导出/显示一律按这个顺序，避免 Ctrl+Shift+X 与 Shift+Ctrl+X 混用 */
export const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
export type Modifier = (typeof MODIFIER_ORDER)[number]

/** 输入里能接受的修饰符别名 → 规范名 */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  ctl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
}

/** 规范里的主键名（大写驼峰）以及输入别名 */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Esc',
  escape: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  bs: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
  // 主键就是加号时没法直接写 "+"，用 Plus 别名表达
  plus: '+',
}
const isAlpha = (ch: string) => /^[a-z]$/i.test(ch)
const MODIFIER_TOKENS = Object.keys(MODIFIER_ALIASES)

export interface ParsedShortcutKeys {
  mods: Modifier[]
  key: string
  canonical: string
}

/**
 * 把任意写法的按键串规范成 `Ctrl+Alt+Shift+Meta` 顺序的规范名。
 * 单体字母保留大小写（浏览器 e.key 已按 Shift 给出大小写）。
 * 无法识别的主键直接抛错——导入时靠它挡住写错的条目。
 */
export function normalizeShortcutKeys(keys: string): string {
  const rawParts = keys
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
  const mods: Modifier[] = []
  for (const part of rawParts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod) mods.push(mod)
  }
  const keyParts = rawParts.filter((p) => !MODIFIER_ALIASES[p.toLowerCase()])
  if (keyParts.length !== 1) {
    throw new Error(`Expected exactly one non-modifier key in "${keys}"`)
  }
  const rawKey = keyParts[0]
  let key = KEY_ALIASES[rawKey.toLowerCase()] || (rawKey.length === 1 ? rawKey : '')
  if (!key) throw new Error(`Unknown key "${rawKey}"`)
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m))
  // 字母大小写按修饰符定死，保证同一按键只有一种规范写法（否则 .json 里 Alt+k 与
  // Alt+K 会被当成两件事）：Ctrl+字母沿用传统大写写法；Alt/Meta 走 ESC 前缀，
  // 约定小写；裸字母保留原样（'a' 与 'A' 在终端里是两个不同字节）
  if (isAlpha(key)) {
    if (ordered.includes('Ctrl')) key = key.toUpperCase()
    else if (ordered.includes('Alt') || ordered.includes('Meta')) key = key.toLowerCase()
  }
  return [...ordered, key].join('+')
}

/** 规范名 → 可查的键名（主键小写），Ctrl/Alt 等修饰符大小写不敏感 */
function parseCanonical(keys: string) {
  return keys
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 按键 → 终端字节。这是「规范」里最关键的一节：
 * - Alt/Meta 按 xterm 惯例编码成 ESC 前缀；缺了它 "Alt+5" 退化成裸 "5"，
 *   tmux 里 M-5(select-layout tiled) 会变成选窗口，布局类宏静默失效
 * - 单键字母按录入时的 Shift 决定大小写
 */
export function keysToEscape(keys: string): string {
  const rawParts = parseCanonical(keys)
  const tokens = rawParts.map((p) => p.toLowerCase())
  const hasCtrl = tokens.includes('ctrl') || tokens.includes('control')
  const hasShift = tokens.includes('shift')
  const hasMeta = tokens.includes('alt') || tokens.includes('meta') || tokens.includes('cmd')
  const withMeta = (payload: string) => (hasMeta ? `\x1b${payload}` : payload)
  const keyRaw = rawParts.find((_, i) => !MODIFIER_TOKENS.includes(tokens[i])) || ''

  if (!keyRaw) return ''
  const key = keyRaw.toLowerCase()

  // Ctrl+Space 是 NUL，必须在空格这层普通映射之前截住，否则会被当成裸空格发出去
  if (hasCtrl && key === 'space') return withMeta('\x00')

  const special = KEY_MAP[key]
  if (special) {
    if (key === 'tab' && hasShift) return withMeta('\x1b[Z')
    if (hasShift && SHIFT_KEY_MAP[key]) return withMeta(SHIFT_KEY_MAP[key])
    return withMeta(special)
  }

  if (key.length === 1) {
    if (hasCtrl) {
      const upper = key.toUpperCase()
      const c = upper.charCodeAt(0)
      if (c >= 65 && c <= 90) return withMeta(String.fromCharCode(c - 64))
      const symbol = CTRL_SYMBOL_MAP[key]
      return symbol ? withMeta(symbol) : ''
    }
    if (isAlpha(key)) return withMeta(hasShift ? key.toUpperCase() : key)
    return withMeta(hasShift ? key.toUpperCase() : keyRaw)
  }

  return ''
}

/** 浏览器 keydown 事件 → 规范按键串（录制用）。保留原始大小写，空格统一写 Space */
export function formatKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const skip = ['Control', 'Alt', 'Shift', 'Meta']
  const key = skip.includes(e.key) ? '' : e.key === ' ' ? 'Space' : e.key
  if (key) parts.push(key)
  return parts.join('+')
}
