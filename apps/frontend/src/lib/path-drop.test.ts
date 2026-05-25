import { describe, expect, it } from 'vitest'
import { decodeDroppedPath, quoteShellPath } from './path-drop'

describe('path-drop', () => {
  it('decodes file and vscode remote paths', () => {
    expect(decodeDroppedPath('file:///tmp/a%20b.txt')).toBe('/tmp/a b.txt')
    expect(decodeDroppedPath('vscode-remote://ssh-remote+host/home/user/a%20b.txt')).toBe('/home/user/a b.txt')
  })
  it('shell quotes dropped paths', () => {
    expect(quoteShellPath("/tmp/a b's.txt")).toBe("'/tmp/a b'\\''s.txt'")
  })
})
