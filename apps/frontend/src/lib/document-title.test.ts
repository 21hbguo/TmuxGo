import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCUMENT_TITLE, formatDocumentTitle } from './document-title'

describe('formatDocumentTitle', () => {
  it('renders host - session: window for an attached session', () => {
    expect(formatDocumentTitle({ hostLabel: 'devbox', sessionName: 'api', windowName: 'logs' })).toBe(
      'devbox - api: logs',
    )
  })
  it('drops the window segment when the session has no active window name', () => {
    expect(formatDocumentTitle({ hostLabel: 'devbox', sessionName: 'api' })).toBe('devbox - api')
    expect(formatDocumentTitle({ hostLabel: 'devbox', sessionName: 'api', windowName: '   ' })).toBe('devbox - api')
  })
  it('falls back to the default title when nothing is attached', () => {
    expect(formatDocumentTitle({})).toBe(DEFAULT_DOCUMENT_TITLE)
    expect(formatDocumentTitle({ hostLabel: 'devbox' })).toBe(DEFAULT_DOCUMENT_TITLE)
    expect(formatDocumentTitle({ hostLabel: 'devbox', sessionName: '  ' })).toBe(DEFAULT_DOCUMENT_TITLE)
  })
  it('keeps the session name alone when the host label is unknown or identical', () => {
    expect(formatDocumentTitle({ sessionName: 'api', windowName: 'logs' })).toBe('api: logs')
    expect(formatDocumentTitle({ hostLabel: 'api', sessionName: 'api', windowName: 'logs' })).toBe('api: logs')
  })
  it('trims stray whitespace instead of leaking it into the tab title', () => {
    expect(formatDocumentTitle({ hostLabel: ' devbox ', sessionName: ' api ', windowName: ' logs ' })).toBe(
      'devbox - api: logs',
    )
  })
  it('matches the title baked into index.html so a cold load does not flash a different label', () => {
    expect(DEFAULT_DOCUMENT_TITLE).toBe('TmuxGo')
  })
})
