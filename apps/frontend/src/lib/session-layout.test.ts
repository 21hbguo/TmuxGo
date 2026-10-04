import { describe, expect, it } from 'vitest'
import { parseSessionLayoutDocument, sessionLayoutToTemplate } from './session-layout'

describe('parseSessionLayoutDocument', () => {
  it('parses a valid layout document', () => {
    const doc = parseSessionLayoutDocument(
      JSON.stringify({
        kind: 'tmuxgo.session-layout',
        version: 1,
        name: 'dev',
        windows: [{ name: 'main', panes: [{ command: 'vim', cwd: '/repo' }] }],
      }),
    )
    expect(doc.name).toBe('dev')
    expect(doc.kind).toBe('tmuxgo.session-layout')
    expect(doc.windows[0].name).toBe('main')
  })
  it('accepts a bare windows payload and defaults the name', () => {
    const doc = parseSessionLayoutDocument(JSON.stringify({ windows: [{ name: 'w', panes: [{}] }] }))
    expect(doc.name).toBe('layout')
    expect(doc.version).toBe(1)
  })
  it('rejects invalid JSON, kinds, versions and empty windows', () => {
    expect(() => parseSessionLayoutDocument('not json')).toThrow('Not valid JSON')
    expect(() => parseSessionLayoutDocument('42')).toThrow('must be an object')
    expect(() => parseSessionLayoutDocument(JSON.stringify({ kind: 'other' }))).toThrow('Unsupported layout kind')
    expect(() =>
      parseSessionLayoutDocument(JSON.stringify({ version: 2, windows: [{ name: 'w', panes: [{}] }] })),
    ).toThrow('Unsupported layout version')
    expect(() => parseSessionLayoutDocument(JSON.stringify({ windows: [] }))).toThrow('no windows')
    expect(() => parseSessionLayoutDocument(JSON.stringify({ windows: [{ panes: [{}] }] }))).toThrow('missing name')
    expect(() => parseSessionLayoutDocument(JSON.stringify({ windows: [{ name: 'w', panes: [] }] }))).toThrow(
      'no panes',
    )
  })
})
describe('sessionLayoutToTemplate', () => {
  it('converts a document into a template usable by the create flow', () => {
    const doc = parseSessionLayoutDocument(
      JSON.stringify({ name: 'dev', windows: [{ name: 'main', panes: [{ command: 'vim' }] }] }),
    )
    const template = sessionLayoutToTemplate(doc)
    expect(template.name).toBe('dev')
    expect(template.layout.windows[0].panes[0].command).toBe('vim')
  })
})
