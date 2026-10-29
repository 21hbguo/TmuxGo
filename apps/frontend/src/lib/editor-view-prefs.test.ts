import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  DEFAULT_EDITOR_VIEW_PREFS,
  clampFontScale,
  cycleWhitespace,
  sanitizeEditorViewPrefs,
  stepFontScale,
  useEditorViewPrefs,
} from './editor-view-prefs'

describe('font scale', () => {
  it('clamps to the supported range and rejects NaN', () => {
    expect(clampFontScale(0.1)).toBe(0.8)
    expect(clampFontScale(99)).toBe(2)
    expect(clampFontScale(Number.NaN)).toBe(1)
    expect(clampFontScale(1.25)).toBe(1.25)
  })

  it('steps through discrete stops', () => {
    expect(stepFontScale(1, 1)).toBe(1.1)
    expect(stepFontScale(1, -1)).toBe(0.9)
    expect(stepFontScale(2, 1)).toBe(2)
    expect(stepFontScale(0.8, -1)).toBe(0.8)
    // 非档位值按「下一个不低于它的档位」起算，避免抖动
    expect(stepFontScale(1.02, 1)).toBe(1.25)
  })
})

describe('whitespace cycling', () => {
  it('cycles none → boundary → all → none', () => {
    expect(cycleWhitespace('none')).toBe('boundary')
    expect(cycleWhitespace('boundary')).toBe('all')
    expect(cycleWhitespace('all')).toBe('none')
  })
})

describe('sanitizeEditorViewPrefs', () => {
  it('falls back to defaults for garbage input', () => {
    expect(sanitizeEditorViewPrefs(null)).toEqual(DEFAULT_EDITOR_VIEW_PREFS)
    expect(sanitizeEditorViewPrefs({ wordWrap: 'yes', renderWhitespace: 'loud', fontScale: 'big' })).toEqual(
      DEFAULT_EDITOR_VIEW_PREFS,
    )
  })

  it('keeps valid overrides and clamps numeric ranges', () => {
    const result = sanitizeEditorViewPrefs({
      wordWrap: true,
      renderWhitespace: 'all',
      fontScale: 9,
      autoSaveDelayMs: 10,
    })
    expect(result.wordWrap).toBe(true)
    expect(result.renderWhitespace).toBe('all')
    expect(result.fontScale).toBe(2)
    expect(result.autoSaveDelayMs).toBe(AUTO_SAVE_DELAY_MIN)
    expect(sanitizeEditorViewPrefs({ autoSaveDelayMs: 99_999 }).autoSaveDelayMs).toBe(AUTO_SAVE_DELAY_MAX)
  })
})

describe('useEditorViewPrefs store', () => {
  afterEach(() => {
    useEditorViewPrefs.getState().reset()
  })

  it('toggles booleans and applies zoom actions', () => {
    const store = useEditorViewPrefs.getState()
    store.toggle('wordWrap')
    expect(useEditorViewPrefs.getState().wordWrap).toBe(true)
    store.zoomIn()
    store.zoomIn()
    expect(useEditorViewPrefs.getState().fontScale).toBe(1.25)
    store.zoomReset()
    expect(useEditorViewPrefs.getState().fontScale).toBe(1)
    store.zoomOut()
    expect(useEditorViewPrefs.getState().fontScale).toBe(0.9)
  })

  it('sets individual preferences and cycles whitespace', () => {
    const store = useEditorViewPrefs.getState()
    store.setPref('autoSave', true)
    expect(useEditorViewPrefs.getState().autoSave).toBe(true)
    store.setPref('renderWhitespace', 'all')
    store.cycleWhitespace()
    expect(useEditorViewPrefs.getState().renderWhitespace).toBe('none')
  })
})
