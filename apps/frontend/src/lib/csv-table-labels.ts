import type { CsvTableLabels } from '@/components/CsvTable'
import type { useTranslation } from '@/i18n'

// CsvTable 不直接依赖 i18n（保持组件可在任意上下文复用），三个调用点的文案在这里收口
export function csvTableLabels(t: ReturnType<typeof useTranslation>['t']): CsvTableLabels {
  return {
    filter: t('editor.csvFilter'),
    copy: t('editor.csvCopy'),
    copied: t('editor.csvCopied'),
    copyCell: t('editor.csvCopyCell'),
    copyColumn: t('editor.csvCopyColumn'),
    copyTable: t('editor.csvCopyTable'),
    copyAsTsv: t('editor.csvCopyAsTsv'),
    copyAsCsv: t('editor.csvCopyAsCsv'),
    copyAsMarkdown: t('editor.csvCopyAsMarkdown'),
    truncatedRows: (max, total) => t('editor.csvTruncatedRows', { max, total }),
    truncatedCols: (max, total) => t('editor.csvTruncatedCols', { max, total }),
    sortAsc: t('editor.csvSortAsc'),
    sortDesc: t('editor.csvSortDesc'),
    clearSort: t('editor.csvClearSort'),
  }
}
