import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('app/manifest', () => {
  it('declares installable png icons for desktop app installs', () => {
    expect(manifest()).toMatchObject({
      name: 'TmuxGo',
      icons: [
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
      ],
    })
  })
})
