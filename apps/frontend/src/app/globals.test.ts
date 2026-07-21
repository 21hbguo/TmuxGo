import { describe, expect, it } from 'vitest'
import css from './globals.css?raw'
describe('globals.css terminal ime styles', () => {
  it('does not override xterm helper textarea dynamic ime geometry', () => {
    const fullSizeBlocks = Array.from(css.matchAll(/([^{}]+)\{[^{}]*\bwidth:\s*100%;[^{}]*\bheight:\s*100%;[^{}]*\}/g)).map((match) => match[1])
    expect(fullSizeBlocks.some((selector) => selector.includes('.xterm-helper-textarea'))).toBe(false)
  })
  it('keeps visible xterm layers stretched to avoid terminal gutters', () => {
    const fullSizeBlocks = Array.from(css.matchAll(/([^{}]+)\{[^{}]*\bwidth:\s*100%;[^{}]*\bheight:\s*100%;[^{}]*\}/g)).map((match) => match[1])
    const visibleFullSizeSelectors = fullSizeBlocks.join('\n')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-screen')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-helpers')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-viewport')
  })
  it('provides liquid glass fallbacks and accessibility modes', () => {
    expect(css).toContain('.tmuxgo-glass')
    expect(css).toContain('-webkit-backdrop-filter: blur(var(--glass-blur))')
    expect(css).toContain('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))')
    expect(css).toContain('@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
