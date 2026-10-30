// CodeMirror 6 的 Markdown live preview 编辑器：源码即真相，光标不在的行按渲染态展示。
//
// 为什么不用 Monaco：0.56 没有 Decoration.replace / atomic ranges，只能靠 CSS 隐藏标记，
// 光标和 IME 会落进不可见文本里；CM6 的 replace + WidgetType 是 Obsidian 同血统的做法。
//
// 与整合方的边界：只经 props/CmMarkdownApi 通信，不 import EditorWorkbench；
// view 只在挂载时创建一次 —— 外部 value 变化走事务替换，撤销栈、滚动位置都不重建。
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { openSearchPanel, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { createMarkdownDecorations, type MarkdownDecorationHost } from '@/lib/cm6/decorations'

export interface CmMarkdownApi {
  focus(): void
  setCursor(line: number, column?: number): void // 1-based
  revealLine(line: number): void // 滚动到行并居中
  openSearch(): void // Ctrl+F 面板
  getScrollTop(): number
  setScrollTop(top: number): void
  getVisibleLineRange(): { from: number; to: number } // 1-based，含首尾
  getSelectionText(): string
}

export interface CmMarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  onSave?: () => void
  onCursorChange?: (info: { line: number; column: number; selectedChars: number }) => void
  onReady?: (api: CmMarkdownApi) => void
  loadImage?: (src: string, path: string | null) => Promise<string | null> // path 为 root 相对路径；null=不解析
  onOpenExternal?: (href: string) => void
  readOnly?: boolean
  fontFamily?: string
  fontSize?: number
  wordWrap?: boolean
  theme?: 'dark' | 'light'
  revealLine?: { line: number; nonce: number } | null // 外部跳转（预览双击）
  autoFocus?: boolean
  ariaLabel?: string
}

const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

interface Compartments {
  theme: Compartment
  wrap: Compartment
  readOnly: Compartment
  attributes: Compartment
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

function attributesExtension(label?: string): Extension {
  const attributes: Record<string, string> = { spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }
  if (label) attributes['aria-label'] = label
  return EditorView.contentAttributes.of(attributes)
}

function countSelected(state: EditorState): number {
  return state.selection.ranges.reduce((total, range) => total + (range.to - range.from), 0)
}

// 直连 EditorView 的主题：颜色全部从 CSS 变量取（项目里是 RGB 三元组，统一 rgb(var(--x))），
// 主题切换只换 Compartment，不重建 view。
function buildTheme(theme: 'dark' | 'light', fontFamily?: string, fontSize?: number): Extension {
  const mono = fontFamily?.trim() || MONO_FALLBACK
  const size = Math.max(10, Math.round(fontSize ?? 13))
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'rgb(var(--text-1))',
        fontSize: `${size}px`,
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: mono, lineHeight: '1.6' },
      '.cm-content': { padding: '12px 16px', caretColor: 'rgb(var(--text-1))' },
      '.cm-line': { padding: '0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--text-1))' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgb(var(--accent) / 0.28)',
      },
      // 搜索面板跟随主题（CM6 默认皮肤在浅色容器里会糊成一片）
      '.cm-panel.cm-search': {
        backgroundColor: 'rgb(var(--bg-1))',
        color: 'rgb(var(--text-1))',
        borderTop: '1px solid var(--line)',
        padding: '6px 8px',
        fontFamily: mono,
        fontSize: '12px',
      },
      '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
        backgroundColor: 'rgb(var(--bg-2))',
        color: 'rgb(var(--text-1))',
        border: '1px solid var(--line)',
        borderRadius: '4px',
        padding: '2px 6px',
      },
      // 标题：字号按级别递进，行距压紧避免行块跳动
      '.cm-md-heading': { fontWeight: '650', color: 'rgb(var(--text-1))' },
      '.cm-md-h1': { fontSize: '1.7em', lineHeight: '1.35' },
      '.cm-md-h2': { fontSize: '1.5em', lineHeight: '1.35' },
      '.cm-md-h3': { fontSize: '1.3em', lineHeight: '1.4' },
      '.cm-md-h4': { fontSize: '1.15em', lineHeight: '1.45' },
      '.cm-md-h5': { fontSize: '1.05em', lineHeight: '1.5' },
      '.cm-md-h6': { fontSize: '1em', color: 'rgb(var(--text-2))' },
      '.cm-md-strong': { fontWeight: '700' },
      '.cm-md-emphasis': { fontStyle: 'italic' },
      '.cm-md-strike': { textDecoration: 'line-through', color: 'rgb(var(--text-3))' },
      '.cm-md-code': {
        fontFamily: mono,
        backgroundColor: 'rgb(var(--bg-2) / 0.7)',
        borderRadius: '3px',
        padding: '0 3px',
      },
      '.cm-md-link': { color: 'rgb(var(--accent-text))', textDecoration: 'underline', textUnderlineOffset: '2px' },
      '.cm-md-quote': {
        borderLeft: '2px solid rgb(var(--accent) / 0.55)',
        paddingLeft: '10px',
        color: 'rgb(var(--text-2))',
      },
      '.cm-md-codeblock': {
        backgroundColor: 'rgb(var(--bg-1) / 0.65)',
        fontFamily: mono,
        fontSize: '0.95em',
        color: 'rgb(var(--text-2))',
      },
      '.cm-md-fence-lang': {
        color: 'rgb(var(--accent-text))',
        fontSize: '0.85em',
        letterSpacing: '0.02em',
      },
      '.cm-md-table': { fontFamily: mono, fontSize: '0.95em', color: 'rgb(var(--text-2))' },
      '.cm-md-bullet': { color: 'rgb(var(--text-3))', marginRight: '0.15em' },
      '.cm-md-checkbox': {
        marginRight: '0.4em',
        verticalAlign: 'middle',
        accentColor: 'rgb(var(--accent))',
        cursor: 'pointer',
      },
      '.cm-md-image': {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: '1.6em',
        padding: '2px 8px',
        borderRadius: '6px',
        border: '1px dashed var(--line-strong)',
        backgroundColor: 'rgb(var(--bg-1) / 0.6)',
        color: 'rgb(var(--text-3))',
        fontSize: '0.9em',
        cursor: 'pointer',
      },
      '.cm-md-image-el': { display: 'block', maxWidth: '100%', borderRadius: '6px' },
      '.cm-md-image-missing': { fontStyle: 'italic' },
    },
    { dark: theme === 'dark' },
  )
}

function clampLine(view: EditorView, line: number): number {
  return Math.min(Math.max(1, Math.round(Number.isFinite(line) ? line : 1)), view.state.doc.lines)
}

function createApi(view: EditorView): CmMarkdownApi {
  return {
    focus: () => view.focus(),
    setCursor: (line, column = 1) => {
      const info = view.state.doc.line(clampLine(view, line))
      const offset = Math.max(0, Math.round(column) - 1)
      const position = Math.min(info.to, info.from + offset)
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'nearest' }),
      })
      view.focus()
    },
    revealLine: (line) => {
      const info = view.state.doc.line(clampLine(view, line))
      view.dispatch({ effects: EditorView.scrollIntoView(info.from, { y: 'center' }) })
    },
    openSearch: () => {
      openSearchPanel(view)
    },
    getScrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop: (top) => {
      view.scrollDOM.scrollTop = Math.max(0, Math.round(top))
    },
    getVisibleLineRange: () => {
      const ranges = view.visibleRanges
      if (!ranges.length) {
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        return { from: line.number, to: line.number }
      }
      return {
        from: view.state.doc.lineAt(ranges[0].from).number,
        to: view.state.doc.lineAt(ranges[ranges.length - 1].to).number,
      }
    },
    getSelectionText: () => {
      const selection = view.state.selection.main
      return view.state.sliceDoc(selection.from, selection.to)
    },
  }
}

export function CmMarkdownEditor(props: CmMarkdownEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const compartmentsRef = useRef<Compartments | null>(null)
  // 最新 props 的引用：回调/主题/只读都从这里取，避免 effect 依赖变化导致重建 view
  const propsRef = useRef(props)
  propsRef.current = props
  const initialRef = useRef(props)
  const revealRef = useRef(props.revealLine)
  revealRef.current = props.revealLine
  const revealNonce = props.revealLine?.nonce ?? 0

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const initial = initialRef.current
    const compartments: Compartments = {
      theme: new Compartment(),
      wrap: new Compartment(),
      readOnly: new Compartment(),
      attributes: new Compartment(),
    }
    compartmentsRef.current = compartments

    const decorationHost: MarkdownDecorationHost = {
      // 通过 ref 取最新回调：整合方换 loadImage 时不需要重建 view
      loadImage: (src, path) => propsRef.current.loadImage?.(src, path) ?? Promise.resolve(null),
      openExternal: (href) => propsRef.current.onOpenExternal?.(href),
    }

    const reportCursor = (state: EditorState) => {
      const handler = propsRef.current.onCursorChange
      if (!handler) return
      const selection = state.selection.main
      const line = state.doc.lineAt(selection.head)
      handler({ line: line.number, column: selection.head - line.from + 1, selectedChars: countSelected(state) })
    }

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          // 必须先于装饰字段：装饰在 create 时就要读语法树
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                propsRef.current.onSave?.()
                return true
              },
            },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          drawSelection(),
          compartments.theme.of(buildTheme(initial.theme ?? 'dark', initial.fontFamily, initial.fontSize)),
          compartments.wrap.of(initial.wordWrap === false ? [] : EditorView.lineWrapping),
          compartments.readOnly.of(readOnlyExtension(initial.readOnly === true)),
          compartments.attributes.of(attributesExtension(initial.ariaLabel)),
          createMarkdownDecorations(decorationHost),
          EditorView.updateListener.of((update) => {
            // 只在文档真的变了才回调；回声由外部 value 与 doc 相等判断拦掉
            if (update.docChanged) propsRef.current.onChange(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) reportCursor(update.state)
          }),
        ],
      }),
    })
    viewRef.current = view
    propsRef.current.onReady?.(createApi(view))
    // 先报一次初始光标，整合方的状态栏不用等用户按键才显示行号
    reportCursor(view.state)
    if (propsRef.current.autoFocus) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
      compartmentsRef.current = null
    }
  }, [])

  // 外观/可编辑性变化：只重配 compartment，不重建 view
  const { theme, fontFamily, fontSize, wordWrap, readOnly, ariaLabel } = props
  useEffect(() => {
    const view = viewRef.current
    const compartments = compartmentsRef.current
    if (!view || !compartments) return
    view.dispatch({
      effects: [
        compartments.theme.reconfigure(buildTheme(theme ?? 'dark', fontFamily, fontSize)),
        compartments.wrap.reconfigure(wordWrap === false ? [] : EditorView.lineWrapping),
        compartments.readOnly.reconfigure(readOnlyExtension(readOnly === true)),
        compartments.attributes.reconfigure(attributesExtension(ariaLabel)),
      ],
    })
  }, [theme, fontFamily, fontSize, wordWrap, readOnly, ariaLabel])

  // 外部 value 变化：整篇替换成一个事务（保留撤销栈），选区夹在新文档范围内
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === props.value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, props.value.length) },
    })
  }, [props.value])

  useEffect(() => {
    const target = revealRef.current
    const view = viewRef.current
    if (!view || !target) return
    const info = view.state.doc.line(clampLine(view, target.line))
    view.dispatch({
      selection: { anchor: info.from },
      effects: EditorView.scrollIntoView(info.from, { y: 'center' }),
    })
    view.focus()
  }, [revealNonce])

  return <div ref={hostRef} className="cm-markdown-host" style={{ height: '100%', minHeight: 0 }} />
}
