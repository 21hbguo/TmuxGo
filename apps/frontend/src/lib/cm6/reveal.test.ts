import { describe, expect, it } from 'vitest'
import { isRangeRevealed, shouldRevealLine } from './reveal'

const cursor = (at: number) => ({ from: at, to: at })
const select = (from: number, to: number) => ({ from, to })

describe('shouldRevealLine', () => {
  it('光标在行内任意位置都展开整行', () => {
    expect(shouldRevealLine(0, 10, cursor(0))).toBe(true)
    expect(shouldRevealLine(0, 10, cursor(4))).toBe(true)
    // 行尾换行前的最后一个位置仍属于本行
    expect(shouldRevealLine(0, 10, cursor(10))).toBe(true)
  })

  it('光标落到下一行行首时不展开上一行', () => {
    expect(shouldRevealLine(0, 10, cursor(11))).toBe(false)
    expect(shouldRevealLine(11, 20, cursor(11))).toBe(true)
  })

  it('空文档的零宽行也能命中光标', () => {
    expect(shouldRevealLine(0, 0, cursor(0))).toBe(true)
  })

  it('选区落在行内即展开', () => {
    expect(shouldRevealLine(0, 10, select(2, 6))).toBe(true)
  })

  it('选区跨多行时每行都展开', () => {
    const selection = select(3, 25)
    expect(shouldRevealLine(0, 10, selection)).toBe(true)
    expect(shouldRevealLine(11, 20, selection)).toBe(true)
    expect(shouldRevealLine(21, 30, selection)).toBe(true)
    expect(shouldRevealLine(31, 40, selection)).toBe(false)
  })

  it('选区与行边界首尾相接也算相交', () => {
    // 选区停在上一行行尾（换行前）
    expect(shouldRevealLine(0, 10, select(0, 10))).toBe(true)
    // 选区正好从本行行首开始
    expect(shouldRevealLine(11, 20, select(11, 11))).toBe(true)
  })

  it('多选时任一相交即展开（调用方 some 组合）', () => {
    const selections = [cursor(2), cursor(31)]
    expect(selections.some((selection) => shouldRevealLine(31, 40, selection))).toBe(true)
    expect(selections.some((selection) => shouldRevealLine(11, 20, selection))).toBe(false)
  })
})

describe('isRangeRevealed', () => {
  it('标记所在行被展开时，标记本身也展开', () => {
    expect(isRangeRevealed({ from: 0, to: 2 }, cursor(5), 0, 10)).toBe(true)
  })

  it('标记不落在选区内且所在行未展开时保持隐藏', () => {
    expect(isRangeRevealed({ from: 0, to: 2 }, cursor(15), 0, 10)).toBe(false)
  })

  it('标记整段落在选区内时展开（行边界裁剪的兜底）', () => {
    expect(isRangeRevealed({ from: 20, to: 24 }, select(20, 24), 0, 10)).toBe(true)
  })

  it('部分重叠不算落在选区内', () => {
    expect(isRangeRevealed({ from: 18, to: 24 }, select(20, 24), 0, 10)).toBe(false)
  })
})
