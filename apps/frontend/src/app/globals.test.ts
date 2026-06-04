import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
describe('globals.css terminal ime styles', () => {
  it('does not override xterm helper textarea dynamic ime geometry', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const fullSizeBlocks = Array.from(css.matchAll(/([^{}]+)\{[^{}]*\bwidth:\s*100%;[^{}]*\bheight:\s*100%;[^{}]*\}/g)).map((match) => match[1])
    expect(fullSizeBlocks.some((selector) => selector.includes('.xterm-helper-textarea'))).toBe(false)
  })
  it('keeps visible xterm layers stretched to avoid terminal gutters', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const fullSizeBlocks = Array.from(css.matchAll(/([^{}]+)\{[^{}]*\bwidth:\s*100%;[^{}]*\bheight:\s*100%;[^{}]*\}/g)).map((match) => match[1])
    const visibleFullSizeSelectors = fullSizeBlocks.join('\n')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-screen')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-helpers')
    expect(visibleFullSizeSelectors).toContain('.xterm .xterm-viewport')
  })
})
