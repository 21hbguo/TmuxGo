import { afterEach, describe, expect, it, vi } from 'vitest'
import { cssColorToHex, ensureTmuxgoTheme, monacoBaseTheme, rgbTripletToHex, tmuxgoThemeName } from './monaco-theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('monaco-theme', () => {
  it('converts rgb triplets to hex', () => {
    expect(rgbTripletToHex('12 13 15')).toBe('#0c0d0f')
    expect(rgbTripletToHex(' 245  245 247 ')).toBe('#f5f5f7')
    expect(rgbTripletToHex('0 0 0')).toBe('#000000')
    expect(rgbTripletToHex('300 13 -5')).toBe('#ff0d00')
    expect(rgbTripletToHex('')).toBeNull()
    expect(rgbTripletToHex('abc')).toBeNull()
  })
  it('converts rgba() literals to hex8', () => {
    expect(cssColorToHex('rgba(255, 255, 255, 0.1)')).toBe('#ffffff1a')
    expect(cssColorToHex('rgba(60, 60, 67, 0.16)')).toBe('#3c3c4329')
    expect(cssColorToHex('rgb(10 132 255)')).toBe('#0a84ff')
    expect(cssColorToHex('12 13 15')).toBe('#0c0d0f')
    expect(cssColorToHex('bogus')).toBeNull()
    expect(cssColorToHex('')).toBeNull()
  })
  it('maps themes to monaco base themes', () => {
    expect(monacoBaseTheme('light')).toBe('vs')
    expect(monacoBaseTheme('high-contrast')).toBe('hc-black')
    for (const t of ['dark', 'dracula', 'nord', 'catppuccin', 'sage']) expect(monacoBaseTheme(t)).toBe('vs-dark')
  })
  it('defines tmuxgo-<theme> with colors from css vars', () => {
    document.documentElement.style.setProperty('--bg-0', '33 34 44')
    document.documentElement.style.setProperty('--text-1', '248 248 242')
    document.documentElement.style.setProperty('--accent', '189 147 249')
    const defineTheme = vi.fn()
    const monaco = { editor: { defineTheme } } as any
    const name = ensureTmuxgoTheme(monaco, 'dracula')
    expect(name).toBe('tmuxgo-dracula')
    expect(defineTheme).toHaveBeenCalledWith(
      'tmuxgo-dracula',
      expect.objectContaining({
        base: 'vs-dark',
        inherit: true,
        colors: expect.objectContaining({
          'editor.background': '#21222c',
          'editor.foreground': '#f8f8f2',
          'editorCursor.foreground': '#bd93f9',
          'editor.selectionBackground': '#bd93f938',
        }),
      }),
    )
  })
  it('falls back to defaults when css vars missing', () => {
    const defineTheme = vi.fn()
    ensureTmuxgoTheme({ editor: { defineTheme } } as any, 'light')
    expect(defineTheme.mock.calls[0][1].base).toBe('vs')
    expect(defineTheme.mock.calls[0][1].colors['editor.background']).toBe('#e8eaee')
  })
  it('names themes per app theme', () => {
    expect(tmuxgoThemeName('dark')).toBe('tmuxgo-dark')
    expect(tmuxgoThemeName('sage')).toBe('tmuxgo-sage')
  })
})
