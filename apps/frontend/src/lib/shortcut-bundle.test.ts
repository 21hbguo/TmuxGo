import { describe, expect, it } from 'vitest'
import {
  buildShortcutBundle,
  parseShortcutBundle,
  serializeShortcutBundle,
  shortcutIdentity,
  shortcutToSteps,
  SHORTCUT_BUNDLE_KIND,
  SHORTCUT_BUNDLE_VERSION,
} from './shortcut-bundle'
import { normalizeShortcutKeys } from './shortcut-keys'
import type { CustomShortcut } from '@/types'

const sample: CustomShortcut[] = [
  {
    id: 'local-only',
    label: '均匀布局',
    steps: [
      { type: 'keys', keys: 'ctrl+b' },
      { type: 'wait', ms: 50 },
      { type: 'keys', keys: 'alt+5' },
    ],
  },
  { id: 'legacy', label: '清屏', mode: 'keys', keys: 'Ctrl+L' },
]

describe('shortcut key notation', () => {
  it('normalises modifier order and aliases', () => {
    expect(normalizeShortcutKeys('shift+ctrl+a')).toBe('Ctrl+Shift+A')
    expect(normalizeShortcutKeys('ALt+F5')).toBe('Alt+F5')
    expect(normalizeShortcutKeys('cmd+space')).toBe('Meta+Space')
    expect(normalizeShortcutKeys('option+return')).toBe('Alt+Enter')
    expect(normalizeShortcutKeys('Ctrl+Plus')).toBe('Ctrl++')
  })
  it('rejects a modifier-only or unknown key', () => {
    expect(() => normalizeShortcutKeys('Ctrl+Shift')).toThrow()
    expect(() => normalizeShortcutKeys('Hyper+1')).toThrow()
  })
})

describe('shortcut bundle format', () => {
  it('exports canonical entries without local ids or legacy fields', () => {
    const bundle = buildShortcutBundle(sample, '2026-10-31T00:00:00.000Z')
    expect(bundle.kind).toBe(SHORTCUT_BUNDLE_KIND)
    expect(bundle.version).toBe(SHORTCUT_BUNDLE_VERSION)
    expect(bundle.shortcuts).toEqual([
      {
        label: '均匀布局',
        repeat: false,
        steps: [
          { type: 'keys', keys: 'Ctrl+B' },
          { type: 'wait', ms: 50 },
          { type: 'keys', keys: 'Alt+5' },
        ],
      },
      { label: '清屏', repeat: false, steps: [{ type: 'keys', keys: 'Ctrl+L' }] },
    ])
    expect(JSON.stringify(bundle)).not.toContain('local-only')
  })
  it('round-trips through serialize/parse', () => {
    const text = serializeShortcutBundle(buildShortcutBundle(sample))
    const parsed = parseShortcutBundle(text)
    expect(parsed.issues).toEqual([])
    expect(parsed.shortcuts).toHaveLength(2)
    expect(parsed.shortcuts[0].steps?.[0]).toEqual({ type: 'keys', keys: 'Ctrl+B' })
  })
  it('accepts a bare array (hand-written lists) and keeps text/wait steps', () => {
    const parsed = parseShortcutBundle(
      JSON.stringify([
        {
          label: '部署',
          steps: [
            { type: 'text', text: 'deploy', appendEnter: true },
            { type: 'wait', ms: 800 },
          ],
        },
      ]),
    )
    expect(parsed.issues).toEqual([])
    expect(parsed.shortcuts[0].steps).toEqual([
      { type: 'text', text: 'deploy', appendEnter: true },
      { type: 'wait', ms: 800 },
    ])
  })
  it('rejects unknown kind/version and broken json', () => {
    expect(() => parseShortcutBundle('{')).toThrow()
    expect(() => parseShortcutBundle(JSON.stringify({ kind: 'other', shortcuts: [] }))).toThrow()
    expect(() =>
      parseShortcutBundle(JSON.stringify({ kind: SHORTCUT_BUNDLE_KIND, version: 9, shortcuts: [] })),
    ).toThrow()
  })
  it('collects per-entry issues and keeps the valid ones', () => {
    const parsed = parseShortcutBundle(
      JSON.stringify({
        kind: SHORTCUT_BUNDLE_KIND,
        version: 1,
        shortcuts: [
          { label: '', steps: [{ type: 'keys', keys: 'Ctrl+A' }] },
          { label: '数字键', steps: [{ type: 'keys', keys: 'Ctrl+1' }] },
          { label: '等待', steps: [{ type: 'wait', ms: 0 }] },
          { label: '好的', steps: [{ type: 'keys', keys: 'ctrl+a' }] },
        ],
      }),
    )
    expect(parsed.shortcuts).toEqual([{ label: '好的', repeat: false, steps: [{ type: 'keys', keys: 'Ctrl+A' }] }])
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['label', 'step-keys', 'step-wait'])
    expect(parsed.issues[1].keys).toBe('Ctrl+1')
  })
  it('treats label plus canonical steps as the identity for de-duplication', () => {
    const a = shortcutIdentity({ label: ' 均匀布局 ', steps: [{ type: 'keys', keys: 'ctrl+b' }] })
    const b = shortcutIdentity({ label: '均匀布局', steps: [{ type: 'keys', keys: 'Ctrl+B' }] })
    const c = shortcutIdentity({ label: '均匀布局', steps: [{ type: 'keys', keys: 'Ctrl+C' }] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
  it('keeps legacy shortcuts expandable when exporting', () => {
    expect(shortcutToSteps({ label: 'X', mode: 'text', text: 'hi', appendEnter: true })).toEqual([
      { type: 'text', text: 'hi', appendEnter: true },
    ])
  })
})
