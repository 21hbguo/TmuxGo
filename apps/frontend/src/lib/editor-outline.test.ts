import { describe, expect, it } from 'vitest'
import {
  buildSymbolTrail,
  extractOutline,
  findSymbolAtLine,
  isOutlineSupported,
  OUTLINE_LIMITS,
} from './editor-outline'

describe('extractOutline', () => {
  it('finds typescript declarations', () => {
    const source = [
      'import { x } from "y"',
      '',
      'export interface Shape {',
      '  area(): number',
      '}',
      '',
      'export class Circle implements Shape {',
      '  constructor(private r: number) {}',
      '  area() {',
      '    return 3.14 * this.r ** 2',
      '  }',
      '}',
      'export function total(a: number) {',
      '  return a',
      '}',
      'export const fast = async (n: number) => n',
      'type Id = string',
      'enum Color { Red }',
    ].join('\n')
    const symbols = extractOutline('typescript', source)
    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.line}`)).toEqual([
      'interface:Shape@3',
      'class:Circle@7',
      'method:constructor@8',
      'method:area@9',
      'function:total@13',
      'function:fast@16',
      'type:Id@17',
      'enum:Color@18',
    ])
  })

  it('derives nesting depth from indentation for python', () => {
    const source = ['class Repo:', '    def load(self):', '        pass', '    async def save(self):', '        pass'].join(
      '\n',
    )
    const symbols = extractOutline('python', source)
    expect(symbols).toEqual([
      { name: 'Repo', kind: 'class', line: 1, column: 1, depth: 0 },
      { name: 'load', kind: 'function', line: 2, column: 5, depth: 2 },
      { name: 'save', kind: 'function', line: 4, column: 5, depth: 2 },
    ])
  })

  it('collects markdown headings with heading depth', () => {
    const source = ['# Title', 'text', '## Section', '### Detail', '## Next'].join('\n')
    expect(extractOutline('markdown', source).map((symbol) => `${symbol.depth}:${symbol.name}`)).toEqual([
      '0:Title',
      '1:Section',
      '2:Detail',
      '1:Next',
    ])
  })

  it('collects go and rust declarations at the top level', () => {
    expect(extractOutline('go', 'func main() {}\nfunc (s *Svc) Run() {}\ntype User struct {}')).toEqual([
      { name: 'main', kind: 'function', line: 1, column: 1, depth: 0 },
      { name: 'Run', kind: 'function', line: 2, column: 1, depth: 0 },
      { name: 'User', kind: 'struct', line: 3, column: 1, depth: 0 },
    ])
    expect(extractOutline('rust', 'pub fn run() {\n  let x = 1;\n}\npub struct Cfg {}\ntrait Thing {}')).toEqual([
      { name: 'run', kind: 'function', line: 1, column: 1, depth: 0 },
      { name: 'Cfg', kind: 'struct', line: 4, column: 1, depth: 0 },
      { name: 'Thing', kind: 'trait', line: 5, column: 1, depth: 0 },
    ])
  })

  it('collects only first level json keys', () => {
    const source = ['{', '  "name": "x",', '  "nested": {', '    "deep": 1', '  },', '  "list": [1]', '}'].join('\n')
    expect(extractOutline('json', source).map((symbol) => symbol.name)).toEqual(['name', 'nested', 'list'])
  })

  it('returns nothing for unsupported languages', () => {
    expect(extractOutline('plaintext', 'a\nb')).toEqual([])
    expect(isOutlineSupported('plaintext')).toBe(false)
    expect(isOutlineSupported('yaml')).toBe(true)
  })

  it('skips absurdly long lines and caps the symbol count', () => {
    const longLine = `function huge() {${'x'.repeat(OUTLINE_LIMITS.maxLineLength)}}`
    expect(extractOutline('typescript', longLine)).toEqual([])
    const many = Array.from({ length: 60 }, (_, index) => `function f${index}() {}`).join('\n')
    expect(extractOutline('typescript', many, { maxSymbols: 10 })).toHaveLength(10)
  })

  it('stays fast on a 20k line file', () => {
    const source = Array.from({ length: 20_000 }, (_, index) =>
      index % 50 === 0 ? `export function handler${index}(input: string) {` : `  const value${index} = ${index}`,
    ).join('\n')
    const started = performance.now()
    const symbols = extractOutline('typescript', source)
    const elapsed = performance.now() - started
    expect(symbols.length).toBe(400)
    // 预算 80ms：远远宽于实测（约 5-15ms），只拦「退化到秒级」的回归
    expect(elapsed).toBeLessThan(80)
  })
})

describe('symbol lookup', () => {
  const symbols = extractOutline(
    'typescript',
    ['export class A {', '  run() {', '  }', '}', 'export function b() {', '}'].join('\n'),
  )

  it('finds the symbol covering a line', () => {
    expect(findSymbolAtLine(symbols, 2)?.name).toBe('run')
    expect(findSymbolAtLine(symbols, 5)?.name).toBe('b')
  })

  it('returns null before the first symbol', () => {
    expect(findSymbolAtLine(symbols, 0)).toBeNull()
    expect(findSymbolAtLine([], 3)).toBeNull()
  })

  it('builds an ancestor trail for breadcrumbs', () => {
    expect(buildSymbolTrail(symbols, 2).map((symbol) => symbol.name)).toEqual(['A', 'run'])
    expect(buildSymbolTrail(symbols, 5).map((symbol) => symbol.name)).toEqual(['b'])
    expect(buildSymbolTrail(symbols, 0)).toEqual([])
  })
})
