import { describe, expect, it } from 'vitest'
import { getDefaultSessionName, getTemplateSessionName } from './session-template'
import type { SessionTemplate } from '@/types'

const defaultTemplate: SessionTemplate = {
  id: 'default',
  name: 'Default',
  description: '',
  layout: { windows: [{ name: 'main', panes: [{}] }] },
}
const devTemplate: SessionTemplate = {
  id: 'dev',
  name: 'Development',
  description: '',
  layout: { windows: [{ name: 'editor', panes: [{}] }] },
}
const named = (...names: string[]) => names.map((name) => ({ name }))

describe('getTemplateSessionName', () => {
  it('slugifies template names', () => {
    expect(getTemplateSessionName(defaultTemplate)).toBe('default')
    expect(getTemplateSessionName(devTemplate)).toBe('development')
  })
})

describe('getDefaultSessionName', () => {
  it('uses workspace name with first free index and no default slug', () => {
    expect(getDefaultSessionName(defaultTemplate, named('dev', 'next'), 'tmuxgo')).toBe('tmuxgo-1')
  })
  it('falls back to session base without a workspace', () => {
    expect(getDefaultSessionName(defaultTemplate, named('dev'))).toBe('session-1')
    expect(getDefaultSessionName(defaultTemplate, named('dev'), '')).toBe('session-1')
  })
  it('fills the smallest unused index', () => {
    expect(getDefaultSessionName(defaultTemplate, named('tmuxgo-1', 'tmuxgo-3'), 'tmuxgo')).toBe('tmuxgo-2')
    expect(getDefaultSessionName(defaultTemplate, named('tmuxgo-1', 'tmuxgo-2'), 'tmuxgo')).toBe('tmuxgo-3')
  })
  it('ignores same-prefix names without numeric suffix', () => {
    expect(getDefaultSessionName(defaultTemplate, named('tmuxgo', 'tmuxgo-x'), 'tmuxgo')).toBe('tmuxgo-1')
  })
  it('keeps the template slug for non-default templates', () => {
    expect(getDefaultSessionName(devTemplate, named('tmuxgo-1'), 'tmuxgo')).toBe('tmuxgo-development-1')
    expect(getDefaultSessionName(devTemplate, named('tmuxgo-development-1'), 'tmuxgo')).toBe('tmuxgo-development-2')
    expect(getDefaultSessionName(devTemplate, [])).toBe('session-development-1')
  })
  it('escapes regex metacharacters in the workspace name', () => {
    expect(getDefaultSessionName(defaultTemplate, named('a.b-1'), 'a.b')).toBe('a.b-2')
    expect(getDefaultSessionName(defaultTemplate, named('aXb-1'), 'a.b')).toBe('a.b-1')
  })
})
