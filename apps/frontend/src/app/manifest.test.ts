import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('app/manifest', () => {
  it('declares installable png icons for desktop app installs', () => {
    const data = manifest()
    expect(data.name).toBe('TmuxGo')
    expect(data.icons).toEqual(expect.arrayContaining([
      {
        src: '/app-icon/192',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/app-icon/512',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]))
  })
})
