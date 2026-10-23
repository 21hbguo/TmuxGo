// Playwright 页面内探针的最小结构类型。探针由 frontend 运行时挂在 window 上，
// 这里只声明 spec 实际读取的字段，避免 any 扩散到断言。
export interface TerminalLine {
  translateToString(trim?: boolean): string
}
export interface TerminalBuffer {
  length: number
  baseY?: number
  getLine(index: number): TerminalLine
}
export interface TerminalProbe {
  cols?: number
  rows?: number
  options?: { fontSize?: number; lineHeight?: number }
  buffer?: { active?: TerminalBuffer }
  select(column: number, row: number, length: number): void
  refresh(start: number, end: number): void
  resize(cols: number, rows: number): unknown
  // xterm 私有渲染管线，仅 render-dedup 的量测用；缺省时走 DOM 尺寸
  _core?: {
    _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } }
  }
  _addonManager?: { _addons?: Array<{ instance?: { proposeDimensions?(): unknown } }> }
}

export interface MonacoRange {
  startLineNumber: number
  endLineNumber: number
  startColumn?: number
  endColumn?: number
}
export interface MonacoPosition {
  lineNumber: number
  column: number
}
export interface MonacoEditor {
  getModel?(): { uri?: { path?: string } } | null
  getPosition?(): MonacoPosition | null
  setPosition?(position: MonacoPosition): void
  getVisibleRanges?(): MonacoRange[]
  revealPositionInCenter?(position: MonacoPosition): void
  focus?(): void
  hasTextFocus?(): boolean
  getScrollTop?(): number
  getScrollLeft?(): number
  getScrollWidth?(): number
  getScrollHeight?(): number
  setScrollTop?(top: number): void
  setScrollLeft?(left: number): void
  getLayoutInfo?(): { width: number; height: number }
  getTopForLineNumber?(line: number): number
  getScrolledVisiblePosition?(position: MonacoPosition): { left: number; top: number; height: number } | null
  getDomNode?(): HTMLElement | null
  executeEdits?(
    source: string,
    edits: Array<{
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
      text: string
    }>,
  ): boolean
}
export interface MonacoApi {
  editor?: { getEditors?(): MonacoEditor[] }
}
