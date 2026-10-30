import { describe, expect, it } from 'vitest'
import { tmuxWindowIdOf, withHostPrefix } from './tmux-host-id'

describe('withHostPrefix', () => {
  it('keeps ids that already carry the host prefix', () => {
    expect(withHostPrefix('local', 'local:@3')).toBe('local:@3')
    expect(withHostPrefix('local', 'local:%5')).toBe('local:%5')
  })
  it('qualifies bare tmux refs', () => {
    expect(withHostPrefix('local', '@3')).toBe('local:@3')
    expect(withHostPrefix('box', '%12')).toBe('box:%12')
  })
  it('treats another host prefix as already qualified (gateway rejects cross-host itself)', () => {
    expect(withHostPrefix('local', 'other:@3')).toBe('other:@3')
  })
  it('returns an empty string for missing refs', () => {
    expect(withHostPrefix('local', '')).toBe('')
    expect(withHostPrefix('local', undefined)).toBe('')
  })
})

describe('tmuxWindowIdOf', () => {
  it('prefers the raw tmux window id', () => {
    expect(tmuxWindowIdOf({ id: 'local:@3', tmuxWindowId: '@3' }, 'local')).toBe('@3')
  })
  it('strips the host prefix when only the composite id is available', () => {
    expect(tmuxWindowIdOf({ id: 'local:@3' }, 'local')).toBe('@3')
  })
  it('returns an empty string without a window', () => {
    expect(tmuxWindowIdOf(null, 'local')).toBe('')
  })
})
