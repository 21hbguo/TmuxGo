// 自定义快捷键的「文件格式 + 纯逻辑」单一事实源。
// 导入/导出、去重、身份判定都走这里；hook 只负责持久化与同步到服务端偏好。
//
// 格式（v1）：
// {
//   "kind": "tmuxgo.shortcuts",
//   "version": 1,
//   "exportedAt": "2026-10-31T02:00:00.000Z",
//   "shortcuts": [
//     { "label": "均匀布局", "repeat": false,
//       "steps": [{ "type": "keys", "keys": "Ctrl+B" }, { "type": "wait", "ms": 50 },
//                 { "type": "keys", "keys": "Alt+5" }] }
//   ]
// }
import type { CustomShortcut, ShortcutStep } from '@/types'
import { keysToEscape, normalizeShortcutKeys } from '@/lib/shortcut-keys'

export const SHORTCUT_BUNDLE_KIND = 'tmuxgo.shortcuts'
export const SHORTCUT_BUNDLE_VERSION = 1
const MAX_LABEL = 64
const MAX_STEPS = 32
const MAX_TEXT = 4096
const MAX_WAIT_MS = 60_000

/** 导出条目：去掉运行期 id 与已废弃的 legacy 字段（mode/keys/text 收进 steps） */
export type ShortcutBundleEntry = Omit<CustomShortcut, 'id'>
/** 入参既可以是打包条目，也可以是带 id 的运行期对象 */
type ShortcutLike = ShortcutBundleEntry | CustomShortcut

export interface ShortcutBundle {
  kind: typeof SHORTCUT_BUNDLE_KIND
  version: typeof SHORTCUT_BUNDLE_VERSION
  exportedAt: string
  shortcuts: ShortcutBundleEntry[]
}

export type ShortcutBundleIssueCode = 'entry' | 'label' | 'steps' | 'step-keys' | 'step-text' | 'step-wait'
export interface ShortcutBundleIssue {
  /** shortcuts 数组里的下标（0 基），提示时 +1 */
  index: number
  code: ShortcutBundleIssueCode
  /** step-keys 里出问题的原始按键串 */
  keys?: string
}

export interface ShortcutBundleParseResult {
  shortcuts: ShortcutBundleEntry[]
  issues: ShortcutBundleIssue[]
}

export function shortcutToSteps(shortcut: ShortcutLike): ShortcutStep[] {
  if (Array.isArray(shortcut.steps) && shortcut.steps.length > 0) return shortcut.steps
  if (shortcut.mode === 'text')
    return [{ type: 'text', text: shortcut.text || '', appendEnter: shortcut.appendEnter === true }]
  return shortcut.keys ? [{ type: 'keys', keys: shortcut.keys }] : []
}

export function stepToInput(step: ShortcutStep): string {
  if (step.type === 'keys') return keysToEscape(step.keys || '')
  if (step.type === 'text') return `${step.text || ''}${step.appendEnter === true ? '\r' : ''}`
  return ''
}

export function shortcutToInput(shortcut: ShortcutLike): string {
  return shortcutToSteps(shortcut).map(stepToInput).join('')
}

export function describeShortcut(shortcut: ShortcutLike): string {
  return shortcutToSteps(shortcut)
    .map((s) => (s.type === 'wait' ? `wait ${s.ms}ms` : s.type === 'text' ? s.text || '' : s.keys || ''))
    .join(' › ')
}

/** 按键串尽量规范化；规范化失败就保留原样（导出不能因为一条脏数据整包失败） */
function bestEffortKeys(keys: string): string {
  try {
    return normalizeShortcutKeys(keys)
  } catch {
    return keys.trim()
  }
}

function canonicalStep(step: ShortcutStep): string {
  if (step.type === 'keys') return `k:${bestEffortKeys(step.keys || '')}`
  if (step.type === 'text') return `t:${step.text || ''}:${step.appendEnter === true ? 1 : 0}`
  return `w:${step.ms ?? 0}`
}

/** 「同一条快捷键」的判定：label 去空白 + 步骤规范化序列。导入去重与合并都用它 */
export function shortcutIdentity(shortcut: ShortcutLike): string {
  const steps = shortcutToSteps(shortcut).map(canonicalStep).join('|')
  return `${shortcut.label.trim()}\u0000${steps}`
}

function canonicalizeStep(step: ShortcutStep): ShortcutStep {
  if (step.type === 'keys') return { type: 'keys', keys: bestEffortKeys(step.keys || '') }
  if (step.type === 'text') return { type: 'text', text: step.text || '', appendEnter: step.appendEnter === true }
  return { type: 'wait', ms: step.ms }
}

export function canonicalizeShortcut(shortcut: ShortcutLike): ShortcutBundleEntry {
  return {
    label: shortcut.label.trim(),
    repeat: shortcut.repeat === true,
    steps: shortcutToSteps(shortcut).map(canonicalizeStep),
  }
}

export function buildShortcutBundle(
  shortcuts: ShortcutBundleEntry[],
  exportedAt = new Date().toISOString(),
): ShortcutBundle {
  return {
    kind: SHORTCUT_BUNDLE_KIND,
    version: SHORTCUT_BUNDLE_VERSION,
    exportedAt,
    shortcuts: shortcuts.map(canonicalizeShortcut),
  }
}

export function serializeShortcutBundle(bundle: ShortcutBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function parseEntry(raw: unknown, index: number, issues: ShortcutBundleIssue[]): ShortcutBundleEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ index, code: 'entry' })
    return null
  }
  const entry = raw as Record<string, unknown>
  const label = typeof entry.label === 'string' ? entry.label.trim() : ''
  if (!label || label.length > MAX_LABEL) {
    issues.push({ index, code: 'label' })
    return null
  }
  const rawSteps = Array.isArray(entry.steps) ? entry.steps : null
  if (!rawSteps || rawSteps.length === 0 || rawSteps.length > MAX_STEPS) {
    issues.push({ index, code: 'steps' })
    return null
  }
  const steps: ShortcutStep[] = []
  for (const rawStep of rawSteps) {
    const step = rawStep && typeof rawStep === 'object' ? (rawStep as Record<string, unknown>) : null
    if (!step) {
      issues.push({ index, code: 'steps' })
      return null
    }
    if (step.type === 'keys') {
      const keys = typeof step.keys === 'string' ? step.keys.trim() : ''
      const canonical = (() => {
        if (!keys) return ''
        try {
          return normalizeShortcutKeys(keys)
        } catch {
          return ''
        }
      })()
      if (!canonical || !keysToEscape(canonical)) {
        issues.push({ index, code: 'step-keys', keys: keys || String(step.keys ?? '') })
        return null
      }
      steps.push({ type: 'keys', keys: canonical })
      continue
    }
    if (step.type === 'text') {
      const text = typeof step.text === 'string' ? step.text : ''
      if (!text.trim() || text.length > MAX_TEXT) {
        issues.push({ index, code: 'step-text' })
        return null
      }
      steps.push({ type: 'text', text, appendEnter: step.appendEnter === true })
      continue
    }
    if (step.type === 'wait') {
      const ms = typeof step.ms === 'number' ? step.ms : Number.NaN
      if (!Number.isFinite(ms) || ms < 1 || ms > MAX_WAIT_MS) {
        issues.push({ index, code: 'step-wait' })
        return null
      }
      steps.push({ type: 'wait', ms: Math.round(ms) })
      continue
    }
    issues.push({ index, code: 'steps' })
    return null
  }
  return { label, repeat: entry.repeat === true, steps }
}

/**
 * 解析导入文本。JSON/kind/version 这类顶层错误直接抛（整包不接受），
 * 单条快捷键的问题收进 issues 并跳过——能导几条就导几条，别因为一条脏数据全废。
 * 也接受裸数组（老格式/手抄清单）。
 */
export function parseShortcutBundle(text: string): ShortcutBundleParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  let list: unknown[]
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    const doc = raw as Record<string, unknown>
    if (doc.kind !== undefined && doc.kind !== SHORTCUT_BUNDLE_KIND)
      throw new Error(`Unsupported shortcuts kind: ${String(doc.kind)}`)
    if (doc.version !== undefined && doc.version !== SHORTCUT_BUNDLE_VERSION)
      throw new Error(`Unsupported shortcuts version: ${String(doc.version)}`)
    if (!Array.isArray(doc.shortcuts)) throw new Error('Shortcuts bundle has no shortcuts array')
    list = doc.shortcuts
  } else {
    throw new Error('Shortcuts bundle must be an object or array')
  }
  const shortcuts: ShortcutBundleEntry[] = []
  const issues: ShortcutBundleIssue[] = []
  list.forEach((item, index) => {
    const parsed = parseEntry(item, index, issues)
    if (parsed) shortcuts.push(parsed)
  })
  return { shortcuts, issues }
}
