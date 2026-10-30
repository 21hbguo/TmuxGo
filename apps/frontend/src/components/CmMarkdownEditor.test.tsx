import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CmMarkdownEditor, type CmMarkdownApi } from './CmMarkdownEditor'

// jsdom 没实现 Range.getClientRects，CM6 的 drawSelection 在测量选区时会调用它。
// 只在测试里补一个空实现，不动 vitest 配置（真实浏览器行为由人工验收覆盖）。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = (() => Object.assign([], { item: () => null })) as unknown as () => DOMRectList
}

function getView(container: HTMLElement): EditorView {
  const dom = container.querySelector('.cm-editor')
  if (!dom) throw new Error('编辑器未挂载')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('未找到 EditorView')
  return view
}

const lineTexts = (container: HTMLElement) =>
  [...container.querySelectorAll('.cm-line')].map((node) => node.textContent ?? '')

afterEach(() => cleanup())

describe('CmMarkdownEditor', () => {
  it('挂载后渲染文档并暴露完整 API', () => {
    const onReady = vi.fn()
    const { container } = render(<CmMarkdownEditor value="plain text" onChange={() => {}} onReady={onReady} />)
    expect(getView(container).state.doc.toString()).toBe('plain text')
    const api = onReady.mock.calls[0][0] as CmMarkdownApi
    expect(Object.keys(api).sort()).toEqual(
      [
        'focus',
        'getScrollTop',
        'getSelectionText',
        'getVisibleLineRange',
        'openSearch',
        'revealLine',
        'setCursor',
        'setScrollTop',
      ].sort(),
    )
  })

  it('编辑通过 onChange 回传整篇文本', () => {
    const onChange = vi.fn()
    const { container } = render(<CmMarkdownEditor value="a" onChange={onChange} />)
    const view = getView(container)
    act(() => {
      view.dispatch({ changes: { from: 1, insert: 'b' } })
    })
    expect(onChange).toHaveBeenCalledWith('ab')
  })

  it('光标变化上报 1-based 行/列与选区字数', () => {
    const onCursorChange = vi.fn()
    const { container } = render(
      <CmMarkdownEditor value={'one\ntwo\nthree'} onChange={() => {}} onCursorChange={onCursorChange} />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: 5 } })
    })
    expect(onCursorChange).toHaveBeenLastCalledWith({ line: 2, column: 2, selectedChars: 0 })
    act(() => {
      view.dispatch({ selection: { anchor: 0, head: 3 } })
    })
    expect(onCursorChange).toHaveBeenLastCalledWith({ line: 1, column: 4, selectedChars: 3 })
  })

  it('光标所在行展开源码，移开后重新隐藏标记', () => {
    const { container } = render(<CmMarkdownEditor value={'# Title\n\nbody'} onChange={() => {}} />)
    const view = getView(container)
    // 初始光标在第 1 行：标题标记以源码形式可见
    expect(lineTexts(container)[0]).toBe('# Title')
    act(() => {
      view.dispatch({ selection: { anchor: 10 } })
    })
    expect(lineTexts(container)[0]).toBe('Title')
    // 标题样式与级别始终挂在行上
    expect(container.querySelector('.cm-md-h1')).toBeTruthy()
  })

  it('任务复选框点击改写源码，撤销可回退', () => {
    const onChange = vi.fn()
    const { container } = render(<CmMarkdownEditor value={'- [x] done\n\nnext'} onChange={onChange} />)
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    const box = container.querySelector('input.cm-md-checkbox') as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.checked).toBe(true)
    act(() => {
      fireEvent.click(box)
    })
    expect(onChange).toHaveBeenLastCalledWith('- [ ] done\n\nnext')
    act(() => {
      undo(view)
    })
    expect(view.state.doc.toString()).toBe('- [x] done\n\nnext')
  })

  it('任务复选框：未勾选点击后写入 [x]', () => {
    const onChange = vi.fn()
    const { container } = render(<CmMarkdownEditor value={'- [ ] open\n\nnext'} onChange={onChange} />)
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    const box = container.querySelector('input.cm-md-checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    act(() => {
      fireEvent.click(box)
    })
    expect(onChange).toHaveBeenLastCalledWith('- [x] open\n\nnext')
  })

  it('只读模式下点击复选框不改文档', () => {
    const onChange = vi.fn()
    const { container } = render(<CmMarkdownEditor value={'- [ ] todo\n\nnext'} onChange={onChange} readOnly />)
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    const box = container.querySelector('input.cm-md-checkbox') as HTMLInputElement
    act(() => {
      fireEvent.click(box)
    })
    expect(view.state.doc.toString()).toBe('- [ ] todo\n\nnext')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('图片 widget：解析前显示占位，resolve 后出现 img，path 为 root 相对', async () => {
    let resolveImage: (value: string | null) => void = () => {}
    const loadImage = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveImage = resolve
        }),
    )
    const { container } = render(
      <CmMarkdownEditor value={'![pic](./img/a-unique-1.png)\n\nx'} onChange={() => {}} loadImage={loadImage} />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    const placeholder = container.querySelector('.cm-md-image') as HTMLElement
    expect(placeholder.textContent).toBe('pic')
    // 解析在微任务里发起：等一拍再断言调用参数
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('./img/a-unique-1.png', 'img/a-unique-1.png'))

    await act(async () => {
      resolveImage('data:image/png;base64,AAAA')
    })
    await waitFor(() => expect(container.querySelector('img.cm-md-image-el')).toBeTruthy())
    expect(container.querySelector('img.cm-md-image-el')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('图片解析失败显示替代文案', async () => {
    const loadImage = vi.fn(async () => null)
    const { container } = render(
      <CmMarkdownEditor value={'![alt text](./missing-unique-2.png)\n\nx'} onChange={() => {}} loadImage={loadImage} />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    await waitFor(() => expect(container.querySelector('.cm-md-image-missing')?.textContent).toBe('alt text'))
  })

  it('图片解析 reject 时回落为「图片不可用」', async () => {
    const loadImage = vi.fn(async () => {
      throw new Error('boom')
    })
    const { container } = render(
      <CmMarkdownEditor value={'![](./missing-unique-4.png)\n\nx'} onChange={() => {}} loadImage={loadImage} />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    await waitFor(() => expect(container.querySelector('.cm-md-image-missing')?.textContent).toBe('图片不可用'))
  })

  it('documentPath 把相对图片解析成 root 相对路径', async () => {
    const loadImage = vi.fn(async () => null)
    const { container } = render(
      <CmMarkdownEditor
        value={'![a](./img/x-unique-5.png)\n\nx'}
        onChange={() => {}}
        loadImage={loadImage}
        documentPath="docs/guide.md"
      />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('./img/x-unique-5.png', 'docs/img/x-unique-5.png'))
  })

  it('documentPath 变化后按新目录重新解析同一张图', async () => {
    const loadImage = vi.fn(async () => null)
    const doc = '![a](./img/x-unique-6.png)\n\nx'
    const { container, rerender } = render(
      <CmMarkdownEditor value={doc} onChange={() => {}} loadImage={loadImage} documentPath="docs/a.md" />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: doc.length } })
    })
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('./img/x-unique-6.png', 'docs/img/x-unique-6.png'))

    rerender(<CmMarkdownEditor value={doc} onChange={() => {}} loadImage={loadImage} documentPath="notes/a.md" />)
    await waitFor(() => expect(loadImage).toHaveBeenLastCalledWith('./img/x-unique-6.png', 'notes/img/x-unique-6.png'))
  })

  it('远程图片：loadImage 收到 null path，点击后交给 onOpenExternal', async () => {
    const onOpenExternal = vi.fn()
    const loadImage = vi.fn(async () => 'data:image/gif;base64,BBBB')
    const { container } = render(
      <CmMarkdownEditor
        value={'![r](https://img.example/a-unique-3.png)\n\nx'}
        onChange={() => {}}
        loadImage={loadImage}
        onOpenExternal={onOpenExternal}
      />,
    )
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('https://img.example/a-unique-3.png', null))
    await waitFor(() => expect(container.querySelector('img.cm-md-image-el')).toBeTruthy())
    act(() => {
      fireEvent.click(container.querySelector('.cm-md-image') as HTMLElement)
    })
    expect(onOpenExternal).toHaveBeenCalledWith('https://img.example/a-unique-3.png')
  })

  it('Ctrl+S 触发 onSave 且不插入字符', () => {
    const onSave = vi.fn()
    const { container } = render(<CmMarkdownEditor value="x" onChange={() => {}} onSave={onSave} />)
    const view = getView(container)
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toBe('x')
  })

  it('Ctrl+F 打开搜索面板，Esc 关闭', async () => {
    const { container } = render(<CmMarkdownEditor value="needle" onChange={() => {}} />)
    const view = getView(container)
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key: 'f', ctrlKey: true })
    })
    const input = container.querySelector('.cm-search input') as HTMLInputElement
    expect(input).toBeTruthy()
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    await waitFor(() => expect(container.querySelector('.cm-search')).toBeFalsy())
  })

  it('外部 value 更新不重建 view，撤销可回到旧内容', () => {
    const { container, rerender } = render(<CmMarkdownEditor value="first" onChange={() => {}} />)
    const view = getView(container)
    rerender(<CmMarkdownEditor value="second" onChange={() => {}} />)
    expect(view.state.doc.toString()).toBe('second')
    expect(getView(container)).toBe(view)
    act(() => {
      undo(view)
    })
    expect(view.state.doc.toString()).toBe('first')
  })

  it('自身 onChange 的回声不回灌文档', () => {
    function Harness() {
      const [value, setValue] = useState('a')
      return <CmMarkdownEditor value={value} onChange={setValue} />
    }
    const { container } = render(<Harness />)
    const view = getView(container)
    act(() => {
      view.dispatch({ changes: { from: 1, insert: 'b' } })
    })
    expect(view.state.doc.toString()).toBe('ab')
    expect(lineTexts(container)[0]).toBe('ab')
  })

  it('revealLine 的 nonce 变化把光标带到目标行', () => {
    const doc = 'l1\nl2\nl3'
    const { container, rerender } = render(<CmMarkdownEditor value={doc} onChange={() => {}} />)
    const view = getView(container)
    rerender(<CmMarkdownEditor value={doc} onChange={() => {}} revealLine={{ line: 3, nonce: 1 }} />)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    rerender(<CmMarkdownEditor value={doc} onChange={() => {}} revealLine={{ line: 2, nonce: 2 }} />)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
  })

  it('API：setCursor / getSelectionText / getVisibleLineRange / 滚动 / openSearch', () => {
    const onReady = vi.fn()
    const { container } = render(<CmMarkdownEditor value={'aa\nbb\ncc'} onChange={() => {}} onReady={onReady} />)
    const view = getView(container)
    const api = onReady.mock.calls[0][0] as CmMarkdownApi

    act(() => api.setCursor(2, 2))
    expect(view.state.selection.main.head).toBe(4)

    act(() => {
      view.dispatch({ selection: { anchor: 0, head: 6 } })
    })
    expect(api.getSelectionText()).toBe('aa\nbb\n')

    const range = api.getVisibleLineRange()
    expect(range.from).toBeGreaterThanOrEqual(1)
    expect(range.to).toBeLessThanOrEqual(view.state.doc.lines)
    expect(range.to).toBeGreaterThanOrEqual(range.from)

    api.setScrollTop(40)
    expect(api.getScrollTop()).toBe(40)

    act(() => api.openSearch())
    expect(container.querySelector('.cm-search')).toBeTruthy()
  })

  it('代码围栏与表格：保留源码，只加行样式与语言标签', () => {
    const doc = '```ts\nconst a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    const { container } = render(<CmMarkdownEditor value={doc} onChange={() => {}} />)
    const view = getView(container)
    act(() => {
      view.dispatch({ selection: { anchor: doc.length } })
    })
    expect(container.querySelectorAll('.cm-md-codeblock')).toHaveLength(3)
    expect(container.querySelectorAll('.cm-md-table')).toHaveLength(3)
    expect(container.querySelector('.cm-md-fence-lang')?.textContent).toBe('ts')
    // 围栏源码行本身可见（不做高亮注入）
    expect(lineTexts(container).slice(0, 3)).toEqual(['```ts', 'const a = 1', '```'])
  })

  it('readOnly 时文档不可改且 contenteditable=false', () => {
    const { container } = render(<CmMarkdownEditor value="a" onChange={() => {}} readOnly />)
    const view = getView(container)
    expect(view.state.readOnly).toBe(true)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
  })
})
