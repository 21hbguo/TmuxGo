// tmux send-keys 逻辑键名白名单（受控闭集）。
//
// 为什么必须是闭集 + 规范化：键名是 send-keys 的「动作」参数而不是字面文本——
// 未经规范化的用户串会被 tmux 当成别的动作解析（`-l` 之外的所有参数都走 key-name
// 解析），既是行为漂移面也是注入面。所以外部只允许传逻辑键名，出网关前统一
// 翻成 tmux 官方拼写；认不出的一律拒绝，绝不把原串透传给 tmux。
//
// 校验语义照 herdr `pane.send_keys`：整组键名全量校验通过才允许写字节，
// 任一非法 → 一个键都不发（半截转义序列会把 pane 应用喂成乱码）。
//
// 刻意不收录的方向：导航类动作（滚动/选区）不走键名，走各自的语义接口
// （pane_scroll 上行 / copy-mode），这样调用方不必知道用户的键表。

// 小写别名 → tmux 官方键名。别名只为好记与跨工具迁移（herdr 用 esc/bs/pageup）。
const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  cr: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'Space',
  spc: 'Space',
  bspace: 'BSpace',
  backspace: 'BSpace',
  bs: 'BSpace',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  ppage: 'PPage',
  pageup: 'PPage',
  pgup: 'PPage',
  prior: 'PPage',
  npage: 'NPage',
  pagedown: 'NPage',
  pgdn: 'NPage',
  next: 'NPage',
  dc: 'DC',
  delete: 'DC',
  del: 'DC',
  ic: 'IC',
  insert: 'IC',
  ins: 'IC',
}
for (let n = 1; n <= 12; n += 1) NAMED_KEYS[`f${n}`] = `F${n}`

// 组合键只放行单修饰键 + 单字符（C-a / M-x / S-1）。多修饰键（C-M-x）与
// 「修饰键 + 具名键」（C-Left）看着方便，但 tmux 侧大小写/别名归一化规则
// 不一致，收益低而踩坑面大——需要时再加，别一次放太宽。
const MODIFIED_KEY = /^([cms])-([a-z0-9])$/i

export const MAX_SEND_KEYS = 16

export function canonicalKeyName(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const named = NAMED_KEYS[trimmed.toLowerCase()]
  if (named) return named
  const modified = MODIFIED_KEY.exec(trimmed)
  if (!modified) return null
  return `${modified[1].toUpperCase()}-${modified[2].toLowerCase()}`
}

export type CanonicalKeyList = { ok: true; keys: string[] } | { ok: false; invalid: string[] }

// 全量校验：任一非法就整体失败并回报全部非法项（不只第一个），
// 调用方据此能一次修完，不用试错。
export function canonicalKeyList(raw: unknown): CanonicalKeyList {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, invalid: [] }
  const keys: string[] = []
  const invalid: string[] = []
  for (const item of raw) {
    const canonical = typeof item === 'string' ? canonicalKeyName(item) : null
    if (canonical) keys.push(canonical)
    else invalid.push(typeof item === 'string' ? item.slice(0, 64) : String(item).slice(0, 64))
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, keys }
}

// 供文档/schema 生成与测试引用：白名单的可枚举笛卡尔积（不是运行时判定依据）
export function listSupportedKeys() {
  return {
    named: [...new Set(Object.values(NAMED_KEYS))],
    modified: ['C', 'M', 'S'].map((m) => `${m}-[a-z0-9]`),
  }
}
