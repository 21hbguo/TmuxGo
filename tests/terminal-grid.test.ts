import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AnsiParser, TerminalGrid } from '../apps/gateway/src/lib/terminal-grid/index'

const fixture = (name: string) => readFileSync(join('tests/fixtures/terminal-streams', name), 'utf8')

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
