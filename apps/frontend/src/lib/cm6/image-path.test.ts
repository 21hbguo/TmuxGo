import { describe, expect, it } from 'vitest'
import { resolveImagePath } from './image-path'

describe('resolveImagePath', () => {
  it('外部地址返回 null，未传 documentPath 时退回「去掉 ./」', () => {
    expect(resolveImagePath('https://img.example/a.png')).toBeNull()
    expect(resolveImagePath('data:image/png;base64,AAAA')).toBeNull()
    expect(resolveImagePath('blob:http://localhost/abc')).toBeNull()
    expect(resolveImagePath('//cdn.example/a.png')).toBeNull()
    expect(resolveImagePath('   ')).toBeNull()
    expect(resolveImagePath('./img/a.png')).toBe('img/a.png')
    expect(resolveImagePath('img/a.png')).toBe('img/a.png')
  })

  it('按 dirname(documentPath) 解析并做 posix 归一化', () => {
    expect(resolveImagePath('./img/a.png', 'docs/a.md')).toBe('docs/img/a.png')
    expect(resolveImagePath('img/a.png', 'docs/a.md')).toBe('docs/img/a.png')
    expect(resolveImagePath('../img/a.png', 'docs/sub/a.md')).toBe('docs/img/a.png')
    // 根目录下的文档：dirname 为空
    expect(resolveImagePath('./img/a.png', 'a.md')).toBe('img/a.png')
    // 文档路径里的冗余段先归一化
    expect(resolveImagePath('img/a.png', 'docs/../notes/a.md')).toBe('notes/img/a.png')
  })

  it('root 绝对路径与越界回退', () => {
    expect(resolveImagePath('/static/a.png', 'docs/a.md')).toBe('static/a.png')
    expect(resolveImagePath('/static/a.png')).toBe('static/a.png')
    // ../ 弹穿 root：退回原样相对路径（不静默改成不存在的路径）
    expect(resolveImagePath('../../a.png', 'docs/a.md')).toBe('../../a.png')
    // 文档路径本身越界：等同没传 documentPath
    expect(resolveImagePath('./img/a.png', '../a.md')).toBe('img/a.png')
  })
})
