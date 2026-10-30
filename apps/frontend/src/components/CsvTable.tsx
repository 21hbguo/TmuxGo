'use client'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { writeClipboardText } from '@/lib/clipboard-text'
import {
  filterTableRows,
  parseCsvTable,
  serializeDelimited,
  serializeTsv,
  sliceTable,
  sortTableRows,
  toMarkdownTable,
} from '@/lib/csv'

// 大表只截 DOM 不截数据：复制读完整 rows，避免「看到多少复制多少」。
// 十万行级 Math.max(...spread) 会 RangeError 打崩整页，列数统计与切片统一用 reduce。
const MAX_ROWS = 5000
const MAX_COLS = 256
export interface CsvTableLabels {
  filter?: string
  copy?: string
  copied?: string
  copyCell?: string
  copyColumn?: string
  copyTable?: string
  copyAsTsv?: string
  copyAsCsv?: string
  copyAsMarkdown?: string
  truncatedRows?: string | ((max: number, total: number) => string)
  truncatedCols?: string | ((max: number, total: number) => string)
  selectRow?: string
  sortAsc?: string
  sortDesc?: string
  clearSort?: string
}
export interface CsvTableProps {
  content: string
  emptyLabel: string
  delimiter?: string
  labels?: CsvTableLabels
  testId?: string
  maxRows?: number
  maxCols?: number
  // 注入复制实现：测试用 mock，生产默认走 clipboard-text（含同步降级）
  copyText?: (text: string) => Promise<unknown> | unknown
}
interface CellPoint {
  row: number
  col: number
}
interface Selection {
  anchor: CellPoint
  focus: CellPoint
}
type SortState = { column: number; direction: 'asc' | 'desc' } | null
type MenuState = { x: number; y: number; point: CellPoint } | null
type DragMode = 'cell' | 'row'
interface DragState {
  pointerId: number
  mode: DragMode
  anchor: CellPoint
}
function normalizeSelection(selection: Selection) {
  const rowFrom = Math.min(selection.anchor.row, selection.focus.row)
  const rowTo = Math.max(selection.anchor.row, selection.focus.row)
  const colFrom = Math.min(selection.anchor.col, selection.focus.col)
  const colTo = Math.max(selection.anchor.col, selection.focus.col)
  return { rowFrom, rowTo, colFrom, colTo }
}
function selectedRows(rows: string[][], selection: Selection) {
  const { rowFrom, rowTo, colFrom, colTo } = normalizeSelection(selection)
  return rows.slice(rowFrom, rowTo + 1).map((row) => row.slice(colFrom, colTo + 1))
}
function withHeader(header: string[], rows: string[][]) {
  return rows.length ? [header, ...rows] : [header]
}
export function CsvTable({
  content,
  emptyLabel,
  delimiter,
  labels = {},
  testId = 'csv-table',
  maxRows = MAX_ROWS,
  maxCols = MAX_COLS,
  copyText,
}: CsvTableProps) {
  const parsed = useMemo(() => parseCsvTable(content, { delimiter }), [content, delimiter])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [copied, setCopied] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [headerRow, ...body] = parsed.rows
  const hasHeader = !!headerRow && parsed.rows.length > 1
  // 排序/筛选只改展示视图；复制取当前视图（所见即所复制）
  const viewBody = useMemo(() => {
    if (!parsed.rows.length) return []
    const filtered = filterTableRows(body, query, false)
    return sort ? sortTableRows(filtered, sort.column, sort.direction, false) : filtered
  }, [body, query, sort, parsed.rows.length])
  const bodySlice = useMemo(() => sliceTable(viewBody, maxRows, maxCols), [viewBody, maxRows, maxCols])
  const displayHeader = useMemo(() => (headerRow ? headerRow.slice(0, Math.max(0, maxCols)) : []), [headerRow, maxCols])
  const displayBody = bodySlice.rows
  const columnCount = useMemo(
    () => displayBody.reduce((max, row) => Math.max(max, row.length), displayHeader.length) || 1,
    [displayBody, displayHeader.length],
  )
  useEffect(() => {
    dragRef.current = null
    setDragging(false)
    setSelection(null)
    setSort(null)
    setMenu(null)
  }, [content])
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    [],
  )
  const copy = useCallback(
    async (text: string, marker = 'copied') => {
      if (!text) return
      // 先亮提示再写剪贴板：写操作可能悬挂（权限弹窗），不能让反馈依赖它
      setCopied(marker)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(''), 1200)
      try {
        await (copyText ? copyText(text) : writeClipboardText(text))
      } catch {
        setCopied('')
      }
    },
    [copyText],
  )
  const copyRows = useCallback(
    (rows: string[][], as: 'tsv' | 'csv' | 'markdown' = 'tsv') => {
      const text =
        as === 'tsv'
          ? serializeTsv(rows)
          : as === 'csv'
            ? serializeDelimited(rows, parsed.delimiter)
            : toMarkdownTable(rows)
      void copy(text)
    },
    [copy, parsed.delimiter],
  )
  const lastCol = Math.max(columnCount - 1, 0)
  // 命中检测走 data-* 而不是坐标：拖拽时 pointermove 的 target 是单元格里的 span，
  // closest 一次就能回到行列；行号列单独标记，拖行号即整行选取。
  const hitTest = useCallback(
    (target: EventTarget | null): { point: CellPoint; mode: DragMode } | null => {
      const element = target instanceof Element ? target.closest<HTMLElement>('[data-csv-cell],[data-csv-row]') : null
      if (!element) return null
      if (element.hasAttribute('data-csv-row')) {
        const row = Number(element.dataset.csvRow)
        return Number.isInteger(row) ? { point: { row, col: lastCol }, mode: 'row' } : null
      }
      const row = Number(element.dataset.row)
      const col = Number(element.dataset.col)
      return Number.isInteger(row) && Number.isInteger(col) ? { point: { row, col }, mode: 'cell' } : null
    },
    [lastCol],
  )
  const beginDrag = (event: ReactPointerEvent<HTMLTableCellElement>, hit: { point: CellPoint; mode: DragMode }) => {
    if (event.button !== 0) return
    // 阻止浏览器原生文本拖选接管指针；表格自己的矩形选区才是唯一语义
    event.preventDefault()
    gridRef.current?.focus({ preventScroll: true })
    const extend = event.shiftKey && selection
    const anchor = extend ? selection.anchor : hit.mode === 'row' ? { row: hit.point.row, col: 0 } : hit.point
    setSelection({ anchor, focus: hit.point })
    dragRef.current = { pointerId: event.pointerId, mode: hit.mode, anchor }
    setDragging(true)
  }
  // 拖出表格/拖到窗口外也要能收尾：pointerup 挂在 window，而不是单元格
  useEffect(() => {
    if (!dragging) return
    const stop = () => {
      dragRef.current = null
      setDragging(false)
    }
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const grid = gridRef.current
      if (grid) {
        // 靠近上下边缘自动滚动：长表拖选不必先松手再滚
        const rect = grid.getBoundingClientRect()
        if (event.clientY < rect.top + 24) grid.scrollTop -= 18
        else if (event.clientY > rect.bottom - 24) grid.scrollTop += 18
      }
      // 指针在表格外时 target 不是单元格；优先 elementFromPoint 拿指针下方的元素
      const under =
        typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : null
      const hit = hitTest(under) ?? hitTest(event.target)
      if (!hit) return
      const focus = drag.mode === 'row' ? { row: hit.point.row, col: lastCol } : hit.point
      setSelection((current) =>
        current && current.focus.row === focus.row && current.focus.col === focus.col
          ? current
          : { anchor: drag.anchor, focus },
      )
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging, lastCol, hitTest])
  const moveBy = (rowDelta: number, colDelta: number, extend: boolean) => {
    setSelection((current) => {
      const base = current?.focus ?? { row: 0, col: 0 }
      const next = {
        row: Math.min(Math.max(base.row + rowDelta, 0), Math.max(displayBody.length - 1, 0)),
        col: Math.min(Math.max(base.col + colDelta, 0), Math.max(columnCount - 1, 0)),
      }
      return extend && current ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next }
    })
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      if (displayBody.length)
        setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: displayBody.length - 1, col: columnCount - 1 },
        })
      return
    }
    if (mod && event.key.toLowerCase() === 'c') {
      // 无选区时不拦截：让浏览器原生 flow 选区照常复制
      if (!selection) return
      event.preventDefault()
      copyRows(selectedRows(displayBody, selection))
      return
    }
    if (event.key === 'Escape') {
      setSelection(null)
      setMenu(null)
      return
    }
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const delta = step[event.key]
    if (delta && displayBody.length) {
      event.preventDefault()
      moveBy(delta[0], delta[1], event.shiftKey)
    }
  }
  const toggleSort = (column: number) => {
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: 'asc' }
      if (current.direction === 'asc') return { column, direction: 'desc' }
      return null
    })
  }
  const openMenu = (event: MouseEvent, point: CellPoint) => {
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const insideSelection =
      !!selection &&
      (() => {
        const { rowFrom, rowTo, colFrom, colTo } = normalizeSelection(selection)
        return point.row >= rowFrom && point.row <= rowTo && point.col >= colFrom && point.col <= colTo
      })()
    if (!insideSelection) setSelection({ anchor: point, focus: point })
    setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0), point })
  }
  const menuSelection = (point: CellPoint) => {
    if (selection) {
      const { rowFrom, rowTo, colFrom, colTo } = normalizeSelection(selection)
      if (point.row >= rowFrom && point.row <= rowTo && point.col >= colFrom && point.col <= colTo)
        return selectedRows(displayBody, selection)
    }
    return [[displayBody[point.row]?.[point.col] ?? '']]
  }
  const menuColumn = (point: CellPoint) => displayBody.map((row) => [row[point.col] ?? ''])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])
  if (!parsed.rows.length)
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-bg-1/60 text-sm text-text-3">{emptyLabel}</div>
    )
  const selectedRange = selection ? normalizeSelection(selection) : null
  const isSelected = (row: number, col: number) =>
    !!selectedRange &&
    row >= selectedRange.rowFrom &&
    row <= selectedRange.rowTo &&
    col >= selectedRange.colFrom &&
    col <= selectedRange.colTo
  const menuItems = menu
    ? [
        {
          key: 'selection',
          label: labels.copy ?? labels.copyCell ?? 'Copy',
          run: () => copyRows(menuSelection(menu.point)),
        },
        { key: 'column', label: labels.copyColumn ?? 'Copy column', run: () => copyRows(menuColumn(menu.point)) },
        {
          key: 'tsv',
          label: labels.copyAsTsv ?? labels.copyTable ?? 'Copy table (TSV)',
          run: () => copyRows(withHeader(headerRow ?? [], viewBody), 'tsv'),
        },
        {
          key: 'csv',
          label: labels.copyAsCsv ?? 'Copy table as CSV',
          run: () => copyRows(withHeader(headerRow ?? [], viewBody), 'csv'),
        },
        {
          key: 'markdown',
          label: labels.copyAsMarkdown ?? 'Copy table as Markdown',
          run: () => copyRows(withHeader(headerRow ?? [], viewBody), 'markdown'),
        },
      ]
    : []
  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="relative flex min-w-0 flex-1 flex-col bg-bg-1/60"
      // 全局 * { -webkit-touch-callout: none } 会关闭移动端长按菜单，表格区域显式恢复
      style={{ WebkitTouchCallout: 'default' } as CSSProperties}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.filter ?? 'Filter'}
          aria-label={labels.filter ?? 'Filter'}
          className="min-w-0 flex-1 rounded-apple border border-[var(--line)] bg-bg-0 px-2 py-1 text-xs text-text-1 outline-none focus:border-accent"
        />
        <span className="shrink-0 text-meta text-text-3" data-testid="csv-table-summary">
          {bodySlice.totalRows}
          {bodySlice.truncatedRows > 0 ? ` (+${bodySlice.truncatedRows})` : ''}
        </span>
        <button
          type="button"
          onClick={() => copyRows(withHeader(headerRow ?? [], viewBody))}
          className="shrink-0 rounded-apple border border-[var(--line)] px-2 py-1 text-meta text-text-2 hover:text-accent"
          data-testid="csv-copy-table"
        >
          {copied === 'copied' ? (labels.copied ?? 'Copied') : (labels.copyTable ?? 'Copy table')}
        </button>
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={testId}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={`tmuxgo-scrollbar min-h-0 flex-1 overflow-auto outline-none ${dragging ? 'select-none' : ''}`}
        data-dragging={dragging ? 'true' : undefined}
      >
        <table className="w-full border-collapse text-sm">
          {hasHeader && (
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 w-10 border border-[var(--line)] bg-bg-2 px-1 py-1 text-right text-meta text-text-3 select-none" />
                {Array.from({ length: columnCount }, (_, index) => (
                  <th
                    key={index}
                    scope="col"
                    aria-sort={
                      sort?.column === index ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className="sticky top-0 z-10 border border-[var(--line)] bg-bg-2 px-2 py-1 text-left font-semibold whitespace-pre text-text-1"
                  >
                    <button
                      type="button"
                      data-testid={`csv-header-${index}`}
                      onClick={() => toggleSort(index)}
                      className="flex w-full items-center gap-1 text-left hover:text-accent"
                      title={
                        sort?.column !== index
                          ? labels.sortAsc
                          : sort.direction === 'asc'
                            ? labels.sortDesc
                            : labels.clearSort
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">{displayHeader[index] ?? ''}</span>
                      <span aria-hidden="true" className="text-meta text-text-3">
                        {sort?.column === index ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {displayBody.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td
                  data-csv-row={rowIndex}
                  onPointerDown={(event) => beginDrag(event, { point: { row: rowIndex, col: 0 }, mode: 'row' })}
                  className="sticky left-0 z-10 w-10 cursor-cell border border-[var(--line)] bg-bg-1 px-1 py-1 text-right text-meta text-text-3 select-none"
                  title={labels.selectRow}
                >
                  {rowIndex + 1}
                </td>
                {Array.from({ length: columnCount }, (_, colIndex) => (
                  <td
                    key={colIndex}
                    data-testid={`csv-cell-${rowIndex}-${colIndex}`}
                    data-csv-cell=""
                    data-row={rowIndex}
                    data-col={colIndex}
                    onPointerDown={(event) =>
                      beginDrag(event, { point: { row: rowIndex, col: colIndex }, mode: 'cell' })
                    }
                    onContextMenu={(event) => openMenu(event, { row: rowIndex, col: colIndex })}
                    className={`max-w-[28rem] cursor-cell border border-[var(--line)] px-2 py-1 align-top whitespace-pre text-text-2 ${
                      isSelected(rowIndex, colIndex) ? 'bg-accent/15' : ''
                    } ${
                      selection?.focus.row === rowIndex && selection.focus.col === colIndex
                        ? 'outline outline-1 -outline-offset-1 outline-accent'
                        : ''
                    }`}
                    title={row[colIndex] ?? ''}
                  >
                    <span className="block max-w-[28rem] overflow-hidden text-ellipsis">{row[colIndex] ?? ''}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(bodySlice.truncatedRows > 0 || bodySlice.truncatedCols > 0) && (
        <div
          className="shrink-0 border-t border-[var(--line)] px-3 py-1 text-meta text-text-3"
          data-testid="csv-truncated"
        >
          {bodySlice.truncatedRows > 0 &&
            (typeof labels.truncatedRows === 'function'
              ? labels.truncatedRows(maxRows, bodySlice.totalRows)
              : (labels.truncatedRows ?? `Only first ${maxRows} of ${bodySlice.totalRows} rows are rendered`))}
          {bodySlice.truncatedRows > 0 && bodySlice.truncatedCols > 0 ? ' · ' : ''}
          {bodySlice.truncatedCols > 0 &&
            (typeof labels.truncatedCols === 'function'
              ? labels.truncatedCols(maxCols, bodySlice.totalCols)
              : (labels.truncatedCols ?? `Only first ${maxCols} of ${bodySlice.totalCols} columns are rendered`))}
        </div>
      )}
      {menu && (
        <div
          role="menu"
          data-testid="csv-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute z-30 w-56 rounded-apple border border-[var(--line)] bg-bg-1 py-1 text-xs shadow-lg"
        >
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-text-2 hover:bg-bg-2 hover:text-text-1"
              onClick={() => {
                item.run()
                setMenu(null)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {copied && (
        <div
          className="pointer-events-none absolute bottom-3 right-3 rounded-apple bg-bg-2 px-2 py-1 text-meta text-accent shadow"
          data-testid="csv-copied"
        >
          {labels.copied ?? 'Copied'}
        </div>
      )}
    </div>
  )
}
