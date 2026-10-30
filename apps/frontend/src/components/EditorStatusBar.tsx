'use client'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { useEditorCursor } from '@/lib/editor-cursor'
import { eolLabel, languageLabel, type EditorEol, type EditorIndentInfo } from '@/lib/editor-status'
import type { WhitespaceMode } from '@/lib/editor-view-prefs'
import { zoomCssPoint } from '@/lib/workspace-zoom'
import { useTranslation } from '@/i18n'
import { EditorContextMenu, type EditorMenuAction } from './EditorContextMenu'

export interface EditorStatusBarViewState {
  wordWrap: boolean
  whitespace: WhitespaceMode
  minimap: boolean
  stickyScroll: boolean
  autoSave: boolean
  zoomPercent: number
}

export interface EditorStatusBarActions {
  gotoLine: () => void
  setIndent: (indent: EditorIndentInfo) => void
  toggleEol: () => void
  toggleWordWrap: () => void
  cycleWhitespace: () => void
  toggleMinimap: () => void
  toggleStickyScroll: () => void
  toggleAutoSave: () => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

export interface EditorStatusBarProps {
  editorId: string
  language: string
  dirty: boolean
  readOnly: boolean
  eol: EditorEol
  eolMixed: boolean
  indent: EditorIndentInfo
  // 和弦提示（按了 Ctrl+K 之后等第二个键）：非空时右下角显示，超时由工作台清空
  chordHint?: string | null
  view: EditorStatusBarViewState
  actions: EditorStatusBarActions
}

const STATUS_ITEM_CLASS =
  'flex h-full items-center gap-1 px-1.5 text-[11px] leading-none text-text-2 transition-colors hover:bg-bg-2/70 hover:text-text-1'
const STATUS_BUTTON_CLASS = cn(STATUS_ITEM_CLASS, 'cursor-pointer')

// 编辑器状态栏（VSCode 底部那条的最小可用版）：
// 左：光标/选区 → 缩进 → 编码 → 行尾；右：语言 → 换行 → 空白 → 缩放 → 保存态
// 光标读的是外置 store，打字时只有这条栏重渲染，工作台不跟着抖
export function EditorStatusBar({
  editorId,
  language,
  dirty,
  readOnly,
  eol,
  eolMixed,
  indent,
  chordHint,
  view,
  actions,
}: EditorStatusBarProps) {
  const { t } = useTranslation()
  const cursor = useEditorCursor(editorId)
  const [indentAnchor, setIndentAnchor] = useState<{ x: number; y: number } | null>(null)
  const [zoomAnchor, setZoomAnchor] = useState<{ x: number; y: number } | null>(null)
  const positionLabel = t('editor.status.position', { line: cursor.line, column: cursor.column })
  const selectionLabel = cursor.selection
    ? cursor.selections > 1
      ? t('editor.status.selectionMulti', { chars: cursor.selection.chars, count: cursor.selections })
      : t('editor.status.selection', { chars: cursor.selection.chars })
    : ''
  const indentLabel = indent.insertSpaces
    ? t('editor.status.indentSpaces', { size: indent.tabSize })
    : t('editor.status.indentTabs')
  const indentActions: EditorMenuAction[] = [
    {
      id: 'spaces-2',
      label: t('editor.status.indentSpaces', { size: 2 }),
      onSelect: () => actions.setIndent({ tabSize: 2, insertSpaces: true }),
    },
    {
      id: 'spaces-4',
      label: t('editor.status.indentSpaces', { size: 4 }),
      onSelect: () => actions.setIndent({ tabSize: 4, insertSpaces: true }),
    },
    {
      id: 'tabs',
      label: t('editor.status.indentTabs'),
      onSelect: () => actions.setIndent({ tabSize: indent.tabSize, insertSpaces: false }),
    },
  ]

  return (
    <div
      data-testid="editor-status"
      className="tmuxgo-editor-status flex h-[22px] shrink-0 items-stretch justify-between gap-2 border-t border-[var(--line)] bg-bg-1 px-2 text-[11px] text-text-2 select-none"
    >
      <div className="flex min-w-0 items-stretch">
        <button
          type="button"
          data-testid="editor-status-position"
          title={t('editor.status.positionAria')}
          aria-label={t('editor.status.positionAria')}
          onClick={actions.gotoLine}
          className={STATUS_BUTTON_CLASS}
        >
          {positionLabel}
        </button>
        {selectionLabel && (
          <span data-testid="editor-status-selection" className={STATUS_ITEM_CLASS}>
            {selectionLabel}
          </span>
        )}
        <button
          type="button"
          data-testid="editor-status-indent"
          title={t('editor.status.indentTitle')}
          aria-label={t('editor.status.indentTitle')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setIndentAnchor(zoomCssPoint(rect.left, rect.top))
          }}
          className={STATUS_BUTTON_CLASS}
        >
          {indentLabel}
        </button>
        <span className={STATUS_ITEM_CLASS} data-testid="editor-status-encoding">
          {t('editor.status.encoding')}
        </span>
        <button
          type="button"
          data-testid="editor-status-eol"
          title={
            eolMixed ? `${t('editor.status.eolTitle')} · ${t('editor.status.eolMixed')}` : t('editor.status.eolTitle')
          }
          aria-label={t('editor.status.eolTitle')}
          onClick={actions.toggleEol}
          className={cn(STATUS_BUTTON_CLASS, eolMixed && 'text-warn')}
        >
          {eolLabel(eol)}
        </button>
      </div>
      <div className="flex min-w-0 items-stretch">
        <button
          type="button"
          data-testid="editor-status-wordwrap"
          aria-pressed={view.wordWrap}
          title={t('editor.cmd.toggleWordWrap')}
          onClick={actions.toggleWordWrap}
          className={cn(STATUS_BUTTON_CLASS, view.wordWrap && 'text-accent')}
        >
          {t('editor.status.wordWrap')}
        </button>
        <button
          type="button"
          data-testid="editor-status-whitespace"
          title={t('editor.cmd.toggleWhitespace')}
          onClick={actions.cycleWhitespace}
          className={cn(STATUS_BUTTON_CLASS, view.whitespace !== 'none' && 'text-accent')}
        >
          ¶
        </button>
        <button
          type="button"
          data-testid="editor-status-zoom"
          title={t('editor.status.zoomTitle')}
          aria-label={t('editor.status.zoomTitle')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setZoomAnchor(zoomCssPoint(rect.left, rect.top))
          }}
          className={STATUS_BUTTON_CLASS}
        >
          {t('editor.status.zoom', { percent: view.zoomPercent })}
        </button>
        <span
          data-testid="editor-status-state"
          title={readOnly ? t('editor.status.readOnly') : dirty ? t('editor.status.dirty') : t('editor.status.saved')}
          className={cn(STATUS_ITEM_CLASS, readOnly ? 'text-warn' : dirty ? 'text-warn' : 'text-text-3')}
        >
          {readOnly ? t('editor.status.readOnly') : dirty ? t('editor.status.dirty') : t('editor.status.saved')}
        </span>
        <span data-testid="editor-status-language" title={language} className={cn(STATUS_ITEM_CLASS, 'text-text-3')}>
          {languageLabel(language)}
        </span>
        {chordHint && (
          <span
            data-testid="editor-status-chord"
            role="status"
            className={cn(STATUS_ITEM_CLASS, 'text-accent font-mono text-[10.5px]')}
          >
            {t('editor.status.chord', { chord: chordHint })}
          </span>
        )}
      </div>
      {zoomAnchor && (
        <EditorContextMenu
          x={zoomAnchor.x}
          y={zoomAnchor.y}
          openUp
          title={t('editor.status.zoomTitle')}
          actions={[
            { id: 'zoom-in', label: t('editor.cmd.zoomIn'), shortcut: 'Ctrl+=', onSelect: actions.zoomIn },
            { id: 'zoom-out', label: t('editor.cmd.zoomOut'), shortcut: 'Ctrl+-', onSelect: actions.zoomOut },
            {
              id: 'zoom-reset',
              label: t('editor.cmd.zoomReset'),
              shortcut: 'Ctrl+0',
              onSelect: actions.resetZoom,
            },
          ]}
          onClose={() => setZoomAnchor(null)}
        />
      )}
      {indentAnchor && (
        <EditorContextMenu
          x={indentAnchor.x}
          y={indentAnchor.y}
          openUp
          title={t('editor.status.indentTitle')}
          actions={indentActions}
          onClose={() => setIndentAnchor(null)}
        />
      )}
    </div>
  )
}
