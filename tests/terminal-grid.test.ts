import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { AnsiParser, TerminalGrid, WIDE_CONT } from '../apps/gateway/src/lib/terminal-grid/index'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/terminal-streams/${name}`, import.meta.url)), 'utf8')

test('plain ascii fixture parses', () => {
  const grid = new TerminalGrid(80, 24)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed(fixture('plain_ascii.txt')).ok, true)
  assert.equal(grid.get(0, 0).cp, 'H'.charCodeAt(0))
})

test('color sgr fixture parses', () => {
  const grid = new TerminalGrid(80, 24)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed(fixture('color_sgr.txt')).ok, true)
})

test('clear and cup fixture parses', () => {
  const grid = new TerminalGrid(80, 24)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed(fixture('clear_and_cup.txt')).ok, true)
  assert.equal(grid.get(4, 9).cp, 'C'.charCodeAt(0))
})

test('spinner fixture stays ok', () => {
  const grid = new TerminalGrid(80, 24)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed(fixture('spinner_sim.txt')).ok, true)
})

test('wide characters preserve xterm cell width', () => {
  const grid = new TerminalGrid(10, 4)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed('A你B').ok, true)
  assert.equal(grid.get(0, 0).text, 'A')
  assert.equal(grid.get(0, 0).width, 1)
  assert.equal(grid.get(1, 0).cp, '你'.codePointAt(0))
  assert.equal(grid.get(1, 0).text, '你')
  assert.equal(grid.get(1, 0).width, 2)
  assert.equal(grid.get(2, 0).cp, WIDE_CONT)
  assert.equal(grid.get(2, 0).text, '')
  assert.equal(grid.get(2, 0).width, 0)
  assert.equal(grid.get(3, 0).cp, 'B'.codePointAt(0))
})

test('combining sequence stays in one grapheme cell', () => {
  const grid = new TerminalGrid(10, 4)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed('e\u0301X').ok, true)
  assert.equal(grid.get(0, 0).text, 'e\u0301')
  assert.equal(grid.get(0, 0).width, 1)
  assert.equal(grid.get(1, 0).text, 'X')
})

test('alternate screen does not overwrite the normal buffer', () => {
  const grid = new TerminalGrid(20, 4)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed('normal').ok, true)
  assert.equal(parser.feed('\x1b[?1049h\x1b[HALT').ok, true)
  assert.equal(grid.get(0, 0).cp, 'A'.codePointAt(0))
  assert.equal(parser.feed('\x1b[?1049l').ok, true)
  assert.equal(grid.get(0, 0).cp, 'n'.codePointAt(0))
})

test('grid resize clears reflowed headless content instead of wrapping it', () => {
  const grid = new TerminalGrid(10, 4)
  const parser = new AnsiParser(grid)
  assert.equal(parser.feed('abcdefghij\r\nklmno').ok, true)
  grid.resize(5, 4)
  assert.equal(parser.feed('X').ok, true)
  assert.equal(grid.get(0, 0).cp, 'X'.codePointAt(0))
  assert.equal(grid.get(4, 0).cp, 0x20)
  assert.equal(grid.get(0, 1).cp, 0x20)
})
