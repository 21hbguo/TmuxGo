'use client'
import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { buildSymbolTrail, type EditorSymbol } from '@/lib/editor-outline'
import { useEditorCursor } from '@/lib/editor-cursor'
import { useTranslation } from '@/i18n'
import { FiChevronRight, FiMoreHorizontal } from 'react-icons/fi'

export interface EditorBreadcrumbsProps {
  editorId: string
  rootLabel: string
  // 相对根目录的路径段（不含文件名）
  directories: string[]
  fileName: string
  // 当前文件的符号表（由工作台防抖解析后传入），符号链按光标行实时算
  symbols: EditorSymbol[]
  onOpenSymbolPicker: () => void
  onRevealDirectory: (directoryPath: string) => void
  onJumpToSymbol: (symbol: EditorSymbol) => void
}

const CRUMB_CLASS =
  'flex h-[20px] max-w-[14rem] items-center truncate rounded-[3px] px-1 text-[11px] leading-none transition-colors hover:bg-bg-2/80 hover:text-text-1'

// 面包屑：路径段 + 当前符号链。路径段点击让文件区定位到该目录（VSCode 的
// 「breadcrumbs 也能导航目录」），符号段是跳到声明行；末尾的文件名点开符号选择器。
export function EditorBreadcrumbs({
  editorId,
  rootLabel,
  directories,
  fileName,
  symbols,
  onOpenSymbolPicker,
  onRevealDirectory,
  onJumpToSymbol,
}: EditorBreadcrumbsProps) {
  const { t } = useTranslation()
  // 光标来自外置 store：面包屑跟着光标变，但不会把工作台拖进重渲染
  const cursor = useEditorCursor(editorId)
  const trail = useMemo(() => buildSymbolTrail(symbols, cursor.line), [symbols, cursor.line])
  const symbolCount = symbols.length
  // 目录层级过深时折叠中间段，避免把文件名挤出可视区
  const collapsed = directories.length > 3
  const visibleDirectories = collapsed ? [directories[0], directories[directories.length - 1]] : directories

  return (
    <nav
      data-testid="editor-breadcrumbs"
      aria-label={t('editor.breadcrumb.symbols')}
      className="tmuxgo-editor-breadcrumbs flex h-[24px] shrink-0 items-center gap-0.5 overflow-hidden border-b border-[var(--line)] bg-bg-0/60 px-2 text-text-3"
    >
      <button
        type="button"
        className={cn(CRUMB_CLASS, 'shrink-0 font-mono')}
        title={t('editor.breadcrumb.openFolder', { name: rootLabel })}
        onClick={() => onRevealDirectory('')}
      >
        {rootLabel || t('editor.breadcrumb.root')}
      </button>
      {(collapsed ? visibleDirectories : directories).map((directory, index) => {
        const realIndex = collapsed ? (index === 0 ? 0 : directories.length - 1) : index
        return (
          <span key={`${directory}-${realIndex}`} className="flex min-w-0 items-center gap-0.5">
            <FiChevronRight aria-hidden="true" size={11} className="shrink-0 text-text-3/60" />
            {collapsed && index === 1 && (
              <>
                <span className={cn(CRUMB_CLASS, 'shrink-0')} aria-hidden="true">
                  <FiMoreHorizontal size={12} />
                </span>
                <FiChevronRight aria-hidden="true" size={11} className="shrink-0 text-text-3/60" />
              </>
            )}
            <button
              type="button"
              className={cn(CRUMB_CLASS, 'font-mono')}
              title={directories.slice(0, realIndex + 1).join('/')}
              onClick={() => onRevealDirectory(directories.slice(0, realIndex + 1).join('/'))}
            >
              {directory}
            </button>
          </span>
        )
      })}
      <FiChevronRight aria-hidden="true" size={11} className="shrink-0 text-text-3/60" />
      <button
        type="button"
        data-testid="editor-breadcrumb-file"
        aria-label={t('editor.quickpick.symbolTitle')}
        className={cn(CRUMB_CLASS, 'shrink-0 font-mono text-text-2')}
        title={symbolCount > 0 ? t('editor.quickpick.symbolTitle') : t('editor.breadcrumb.noSymbols')}
        onClick={onOpenSymbolPicker}
      >
        {fileName}
      </button>
      {trail.map((symbol, index) => (
        <span key={`${symbol.kind}-${symbol.line}-${index}`} className="flex min-w-0 items-center gap-0.5">
          <FiChevronRight aria-hidden="true" size={11} className="shrink-0 text-text-3/60" />
          <button
            type="button"
            data-testid={`editor-breadcrumb-symbol-${index}`}
            className={cn(CRUMB_CLASS, index === trail.length - 1 && 'text-text-1')}
            title={`${symbol.kind} · ${t('editor.status.position', { line: symbol.line, column: symbol.column })}`}
            onClick={() => onJumpToSymbol(symbol)}
          >
            {symbol.name}
          </button>
        </span>
      ))}
    </nav>
  )
}
